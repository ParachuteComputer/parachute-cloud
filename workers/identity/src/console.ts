/**
 * The self-serve console — accounts + vaults, on the Identity Worker itself
 * (it already owns users, sessions, cookies, and the rendered-HTML surface).
 *
 * Routes (all pure `(db, req, deps)` like the OAuth handlers):
 *   GET  /signup             create-account form
 *   POST /signup             create user + session → /console
 *   GET  /login              console sign-in form
 *   POST /login              verify + session → /console
 *   POST /logout             clear session → /login
 *   GET  /console            zero vaults → the first-run hero ("Name your
 *                            vault"); otherwise the checklist card + vault
 *                            cards + create form
 *   POST /console/vaults     claim a vault name → 303 straight to the new
 *                            vault's Notes UI (the everyday-user door; the
 *                            console stays reachable for plan/billing).
 *   POST /console/packs      apply a seed pack to an owned vault (server-side
 *                            call to the vault worker with an internally minted
 *                            scoped token) → /console?pack_added=<name>
 *   POST /console/vaults/export  stream an owned vault's portable-md export
 *                            tarball back as a download (the same mint seam,
 *                            read verb — see handleExportPost)
 *   POST /console/checklist  mark a getting-started item done (or `hidden` to
 *                            dismiss the card) → 302 to the item's destination
 *                            (door items) or /console
 *
 * A cloud login session (parachute_id_session) is the same cookie the OAuth
 * authorize flow uses, so signing in here also carries you through a subsequent
 * connect-your-AI consent without a second login.
 */
import { ensureCsrfToken, verifyCsrfToken } from "./csrf.ts";
import {
  checkAndBumpSignup,
  clearLoginFailures,
  clientIp,
  isLoginLocked,
  loginKey,
  recordLoginFailure,
} from "./rate-limit.ts";
import {
  SESSION_COOKIE,
  clearSessionCookie,
  deleteSession,
  parseSessionCookie,
} from "./sessions.ts";
import { sessionUser } from "./session-user.ts";
import { finishPrimaryAuth } from "./auth-handlers.ts";
import { EMAIL_RE, PASSWORD_MIN } from "./validation.ts";
import { createUser, getUserByEmail, needsRehash, setPassword, verifyPassword, type User } from "./users.ts";
import {
  VaultNameInvalidError,
  VaultNameTakenError,
  clearImportPending,
  countVaultsForOwner,
  createVault,
  getVault,
  listVaultsForOwner,
  userOwnsVault,
} from "./vaults.ts";
import {
  PLAN_SPECS,
  canStartCheckout,
  entitlementPlanFor,
  isPaidTier,
  isPlanId,
  planEntitlement,
  restoreAtCapMessage,
  trialTierChosenMessage,
  vaultCapMessage,
} from "./plans.ts";
import { applyPlanToVaults, callVaultApi, callVaultImport, pushVaultCap } from "./vault-call.ts";
import {
  callVaultRestore,
  isKnownSnapshot,
  listSnapshotsForVaults,
  restoredVaultName,
} from "./snapshots.ts";
import {
  getChecklistState,
  isChecklistItem,
  markChecklistItem,
  unhideChecklist,
} from "./checklist.ts";
import { latestUsageForVaults } from "./usage.ts";
import { isTotpEnrolled } from "./two-factor.ts";
import {
  type ConsoleVaultCard,
  type FirstRunValues,
  renderConsole,
  renderConsoleLogin,
  renderSignup,
} from "./ui.ts";
import {
  type OAuthDeps,
  htmlResponse,
  isSameOriginRequest,
  redirectResponse,
  resolveBoundOrigins,
  vaultInstanceUrl,
} from "./oauth-shared.ts";

function csrfExtra(setCookie?: string): Record<string, string> {
  return setCookie ? { "set-cookie": setCookie } : {};
}

// --- signup ----------------------------------------------------------------

export function handleSignupGet(req: Request): Response {
  const csrf = ensureCsrfToken(req);
  return htmlResponse(renderSignup({ csrfToken: csrf.token }), 200, csrfExtra(csrf.setCookie));
}

export async function handleSignupPost(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const form = await req.formData();
  if (!verifyCsrfToken(req, form) || !isSameOriginRequest(req, resolveBoundOrigins(deps))) {
    return signupError(req, "Your session expired. Please try again.", "");
  }
  const email = String(form.get("email") ?? "").trim();
  const password = String(form.get("password") ?? "");
  if (!EMAIL_RE.test(email)) return signupError(req, "Enter a valid email address.", email);
  if (password.length < PASSWORD_MIN) return signupError(req, `Password must be at least ${PASSWORD_MIN} characters.`, email);

  // DO-backed abuse fence, fail-open (see rate-limit.ts for the documented limits).
  const throttle = await checkAndBumpSignup(deps.rateLimiter, clientIp(req), deps.now?.() ?? new Date());
  if (!throttle.allowed) {
    return signupError(req, "Too many signups from this network. Try again later.", email);
  }

  if (await getUserByEmail(db, email)) {
    return signupError(req, "An account with that email already exists.", email);
  }
  const user = await createUser(db, email, password, deps.now?.() ?? new Date());
  // A brand-new user has no 2FA, so this mints a session directly; funnel through
  // the shared fork anyway for one primary-auth path.
  return finishPrimaryAuth(db, deps, user.id, "/console");
}

function signupError(req: Request, message: string, email: string): Response {
  const csrf = ensureCsrfToken(req);
  return htmlResponse(renderSignup({ csrfToken: csrf.token, error: message, email }), 200, csrfExtra(csrf.setCookie));
}

// --- login / logout --------------------------------------------------------

export function handleLoginGet(req: Request): Response {
  const csrf = ensureCsrfToken(req);
  return htmlResponse(renderConsoleLogin({ csrfToken: csrf.token }), 200, csrfExtra(csrf.setCookie));
}

export async function handleLoginPost(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const form = await req.formData();
  if (!verifyCsrfToken(req, form) || !isSameOriginRequest(req, resolveBoundOrigins(deps))) {
    return loginError(req, "Your session expired. Please try again.", "");
  }
  const email = String(form.get("email") ?? "").trim();
  const password = String(form.get("password") ?? "");
  const now = deps.now?.() ?? new Date();
  // Brute-force fence BEFORE the (expensive) password verify: a locked key is
  // refused without even running PBKDF2.
  const key = loginKey(clientIp(req), email);
  if ((await isLoginLocked(deps.rateLimiter, key, now)).locked) {
    return loginError(req, "Too many attempts. Please wait a few minutes and try again.", email);
  }
  const user = email ? await getUserByEmail(db, email) : null;
  // A SUSPENDED account fails with the exact wrong-password message — even on
  // the correct password (suspension is never revealed; migration 0011). The
  // failure is recorded like any other so the fence stays indistinguishable.
  if (!user || !(await verifyPassword(user, password)) || user.suspendedAt) {
    await recordLoginFailure(deps.rateLimiter, key, now);
    return loginError(req, "Incorrect email or password.", email);
  }
  await clearLoginFailures(deps.rateLimiter, key);
  // Transparent KDF upgrade: a verified-correct password stored under the
  // legacy sha256 verifier is re-hashed to the current format (users.ts, #28).
  if (needsRehash(user)) await setPassword(db, user.id, password);
  // 2FA on → this diverts to the code prompt; otherwise it mints the session.
  return finishPrimaryAuth(db, deps, user.id, "/console");
}

function loginError(req: Request, message: string, email: string): Response {
  const csrf = ensureCsrfToken(req);
  return htmlResponse(renderConsoleLogin({ csrfToken: csrf.token, error: message, email }), 200, csrfExtra(csrf.setCookie));
}

export async function handleLogoutPost(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const form = await req.formData();
  if (!verifyCsrfToken(req, form) || !isSameOriginRequest(req, resolveBoundOrigins(deps))) {
    return redirectResponse("/console");
  }
  const sessionId = parseSessionCookie(req.headers.get("cookie"));
  if (sessionId) await deleteSession(db, sessionId);
  return redirectResponse("/login", { "set-cookie": clearSessionCookie() });
}

// --- console ---------------------------------------------------------------

/**
 * The standalone Notes PWA deploy. `/?add=<vault URL>` jumps straight into the
 * connect flow for that vault — the console's everyday-user door onto a fresh
 * vault (the CLI/MCP card stays as the "Connect your AI" secondary).
 */
const NOTES_APP_URL = "https://notes.parachute.computer";

function cardFor(name: string, deps: OAuthDeps): ConsoleVaultCard {
  const base = vaultInstanceUrl(name, deps);
  return {
    name,
    notesUrl: `${NOTES_APP_URL}/?add=${encodeURIComponent(base)}`,
    // The PWA's connect flow honors a `redirect` companion: connect the vault
    // (or skip if already connected), then land on the given view. write-note
    // lands on the new-note editor (/new — notes-ui 0.1.10 shipped the
    // redirect fix); import-notes lands on /import.
    writeUrl: `${NOTES_APP_URL}/?add=${encodeURIComponent(base)}&redirect=${encodeURIComponent("/new")}`,
    importUrl: `${NOTES_APP_URL}/?add=${encodeURIComponent(base)}&redirect=${encodeURIComponent("/import")}`,
    mcpUrl: `${base}/mcp`,
    connectCmd: `claude mcp add --transport http parachute-${name} ${base}/mcp`,
  };
}

/**
 * Render the console for `user` in its current state — the single render path
 * for GET /console and every error re-render, so the first-run hero vs
 * checklist-plus-cards decision lives in exactly one place.
 */
async function renderConsoleFor(
  db: D1Database,
  req: Request,
  deps: OAuthDeps,
  user: User,
  opts: { error?: string; notice?: string; firstRun?: FirstRunValues } = {},
): Promise<Response> {
  const vaults = await listVaultsForOwner(db, user.id);
  const cards = vaults.map((v) => cardFor(v.name, deps));
  // Latest recorded usage per vault (the daily rollup's `vault_usage` rows,
  // usage.ts). A vault without a row yet — created since the last rollup, or
  // its read failed — renders the "appears within a day" line instead; the
  // plan line totals only what's recorded.
  const usage = await latestUsageForVaults(db, vaults.map((v) => v.name));
  for (const card of cards) {
    const row = usage.get(card.name);
    card.usage = row ? { usedBytes: row.dbBytes + row.r2Bytes, day: row.day } : null;
  }
  // History (Wave 4e): restore points from the D1 snapshot mirror — paid
  // plans see the list + restore doors; free plans see the teaser (their
  // rolling weekly is OUR disaster-recovery artifact, never surfaced).
  if (PLAN_SPECS[user.plan].restore) {
    const snapshots = await listSnapshotsForVaults(db, vaults.map((v) => v.name));
    for (const card of cards) {
      const rows = snapshots.get(card.name) ?? [];
      card.history = {
        kind: "restore-points",
        entries: rows.map((r) => ({ key: r.key, takenAt: r.takenAt, bytes: r.bytes, ranks: r.ranks })),
      };
    }
  } else {
    for (const card of cards) card.history = { kind: "teaser" };
  }
  const recorded = [...usage.values()];
  const totalUsedBytes =
    recorded.length > 0 ? recorded.reduce((sum, r) => sum + r.dbBytes + r.r2Bytes, 0) : null;
  // The checklist card renders once a vault exists, until dismissed. Its doors
  // open the FIRST (oldest) vault — the one the first-run flow created.
  let checklist = null;
  let checklistHidden = false;
  if (cards.length > 0) {
    const state = await getChecklistState(db, user.id);
    checklistHidden = state.hidden;
    if (!state.hidden) {
      checklist = {
        done: state.done,
        vault: cards[0]!,
        // Quiet one-liner in the card footer; dismissed with the card. 2FA
        // stays a surfaced OPTION, never a wall.
        showTwoFactorNudge: !(await isTotpEnrolled(db, user.id)),
      };
    }
  }
  // Trial-tier banner + card-badge state (trial users only). The tier the trial
  // currently mirrors is entitlementPlanFor(plan, pending) — a paid pending tier
  // → that tier; the signup default (pending='expired'/null) → Plus (the trial
  // spec mirrors Plus), flagged `isDefault` so the banner reads honestly. Days
  // left come from the plan_downgrade_at clock.
  let trial: {
    tierLabel: string;
    isDefault: boolean;
    daysLeft: number | null;
    currentTier: "entry" | "standard" | "plus" | "power";
  } | null = null;
  if (user.plan === "trial") {
    const effective = entitlementPlanFor(user.plan, user.pendingPlan);
    const isDefault = !isPaidTier(effective);
    const currentTier = isPaidTier(effective) ? effective : "plus";
    const nowMs = (deps.now?.() ?? new Date()).getTime();
    const daysLeft = user.planDowngradeAt
      ? Math.max(0, Math.ceil((Date.parse(user.planDowngradeAt) - nowMs) / 86_400_000))
      : null;
    trial = { tierLabel: PLAN_SPECS[currentTier].label, isDefault, daysLeft, currentTier };
  }
  const csrf = ensureCsrfToken(req);
  return htmlResponse(
    renderConsole({
      email: user.email,
      vaults: cards,
      csrfToken: csrf.token,
      error: opts.error,
      notice: opts.notice,
      checklist,
      trial,
      // Dismissed → the quiet "Show setup guide" footer link brings it back.
      showChecklistRestore: checklistHidden,
      firstRun: opts.firstRun,
      plan: user.plan,
      // Honest paid-until surface: a scheduled downgrade to the expired floor
      // (the 30-day trial clock, a promo comp's expiry, or a real subscription's
      // scheduled cancel) shows its date on the plan line — never a silent cliff.
      planUntil: user.pendingPlan === "expired" && user.planDowngradeAt ? user.planDowngradeAt : null,
      totalUsedBytes,
      // Billing doors (Wave 4d): Upgrade for free users / Manage billing for
      // paid users WITH a Stripe customer (comped accounts have none) — both
      // only while billing is configured (billing-config.ts; unconfigured =
      // today's deploy = the teaser stays and no billing UI exists).
      billingConfigured: deps.billingConfigured === true,
      // Interim MOCK path (mock-payments): non-prod + no real Stripe (or the
      // explicit MOCK_BILLING flag). Upgrade buttons then POST the mock
      // endpoint + a "test mode" label; ALWAYS false in production.
      mockBillingEnabled: deps.mockBillingEnabled === true,
      hasBillingAccount: user.stripeCustomerId !== null,
      // Trial/expired with no live subscription → the tier chooser + promo box
      // render; a paid tier gets Manage-billing; a live sub gets neither.
      canCheckout: canStartCheckout(user.plan),
      // At (or over — grandfathered) the plan's vault count: the create form
      // gives way to the friendly at-cap note. The POST handler is the real
      // gate; this just keeps the UI honest.
      atVaultCap: cards.length >= PLAN_SPECS[user.plan].vault_count,
      // Operators get the quiet Admin header link (the surface itself 404s
      // for everyone else — admin.ts).
      isOperator: user.role === "operator",
    }),
    200,
    csrfExtra(csrf.setCookie),
  );
}

/**
 * Billing feedback rides the redirect as allowlisted CODES (the admin.ts
 * pattern) — the query string is user-editable, so it can only ever pick
 * from this fixed copy, never inject its own text.
 */
const BILLING_ERRORS: Record<string, string> = {
  session: "Your session expired. Please try again.",
  invalid: "Invalid request. Please try again.",
  already: "You're already on a paid plan — use Manage billing to make changes.",
  "no-billing": "This account has no billing profile to manage. Write hello@parachute.computer if something looks off.",
  stripe: "Couldn't reach the payment provider just now. Please try again in a moment.",
};

/**
 * Promo-code feedback (promo.ts handlePromoRedeemPost) — same allowlisted-code
 * pattern; the four distinct refusals each get their own honest copy.
 */
const PROMO_ERRORS: Record<string, string> = {
  session: "Your session expired. Please try again.",
  invalid: "That code isn't one we recognize — check the spelling and try again.",
  exhausted: "That code has been fully redeemed — every spot is taken. Write hello@parachute.computer if you think that's wrong.",
  "already-used": "This account has already redeemed a code — codes are one per account.",
  "already-paid": "You're already on a paid plan, so there's nothing for a code to add.",
};

/**
 * Pick-a-plan (POST /console/plan) feedback — the same allowlisted-code pattern.
 * `reactivate` is the load-bearing refusal: an EXPIRED user can't get a free
 * paid tier here (only a live trial re-mirrors for free), so they're pointed at
 * checkout instead of being silently un-frozen.
 */
const PLAN_ERRORS: Record<string, string> = {
  session: "Your session expired. Please try again.",
  invalid: "That plan isn't one we recognize. Please try again.",
  reactivate: "Your trial has ended — add a payment method to pick a plan again. Your notes stay readable and exportable anytime.",
  already: "You're already on a paid plan — use Manage billing to change tiers.",
};

export async function handleConsoleGet(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const user = await sessionUser(db, req, deps);
  if (!user) return redirectResponse("/login");
  const vaults = await listVaultsForOwner(db, user.id);
  const params = new URL(req.url).searchParams;
  const created = params.get("created");
  // Render the pack notice only for a vault this user actually owns — the
  // param is user-editable (it's escaped either way; this just keeps a crafted
  // ?pack_added=whatever from painting a false success banner).
  const packAdded = params.get("pack_added");
  const packVault = packAdded && vaults.some((v) => v.name === packAdded) ? packAdded : null;
  // Restore success notice — only for a vault this user actually owns (the
  // param is user-editable; same rule as pack_added). The attachments caveat
  // rides the success message: honesty at the exact moment it matters.
  const restoredParam = params.get("restored");
  const restoredVault = restoredParam && vaults.some((v) => v.name === restoredParam) ? restoredParam : null;
  // Import success notice — only for a vault this user actually owns (the param
  // is user-editable; same rule as restored/pack_added). The note count + any
  // attachment caveat ride the redirect as numbers (clamped defensively).
  const importedParam = params.get("imported");
  const importedVault = importedParam && vaults.some((v) => v.name === importedParam) ? importedParam : null;
  const importedNotes = Math.max(0, Math.trunc(Number(params.get("notes") ?? "")) || 0);
  const importedSkipped = Math.max(0, Math.trunc(Number(params.get("skipped") ?? "")) || 0);
  const importNotice = importedVault
    ? `Imported into "${importedVault}" — ${importedNotes} ${importedNotes === 1 ? "note is" : "notes are"} ready.` +
      (importedSkipped > 0
        ? ` Heads up: ${importedSkipped} attachment ${importedSkipped === 1 ? "file" : "files"} couldn't be carried over — the notes and their references are in, but ${importedSkipped === 1 ? "the file itself is" : "the files themselves are"} not.`
        : "")
    : null;
  // Promo success copy renders from the ROW (plan + plan_downgrade_at), never
  // from the query string — the param only picks the message; the date is the
  // stored truth (honest even on a stale/replayed URL).
  const promoRedeemed =
    params.get("promo_redeemed") && isPaidTier(user.plan) && user.planDowngradeAt
      ? `Code redeemed — you're on the ${PLAN_SPECS[user.plan].label} plan until ${user.planDowngradeAt.slice(0, 10)}. Welcome aboard.`
      : null;
  // Pick-a-plan confirmation (POST /console/plan) — rendered from the STORED
  // truth, never the query string: only when the user is a trial whose
  // pending_plan actually names the tier the param claims (an honest banner even
  // on a stale/replayed URL, the promo pattern).
  const planChosenParam = params.get("plan_chosen") ?? "";
  const planChosen =
    isPlanId(planChosenParam) &&
    isPaidTier(planChosenParam) &&
    user.plan === "trial" &&
    user.pendingPlan === planChosenParam
      ? trialTierChosenMessage(planChosenParam)
      : null;
  const notice = created
    ? `Your vault "${created}" is ready — open your notes, or connect your AI below.`
    : importNotice
    ? importNotice
    : restoredVault
      ? `Snapshot restored into "${restoredVault}" — a new vault; the original is untouched. Heads up: v1 snapshots don't include attachment files, so notes and their attachment references are back but the files themselves aren't.`
      : packVault
      ? `Surface Starter added to ${packVault} — ask your connected AI to read it.`
      : promoRedeemed
        ? promoRedeemed
        : planChosen
        ? planChosen
        : params.get("mock_upgraded")
        ? `Test purchase complete — no real charge. You're on the ${PLAN_SPECS[user.plan].label} plan now (mock billing; the caps and any voice entitlement lifted exactly as a real payment would).`
        : params.get("upgraded")
          ? "Thanks — payment received. Your plan activates the moment Stripe's confirmation lands (usually seconds)."
          : params.get("checkout_canceled")
            ? "Checkout canceled — nothing changed."
            : undefined;
  const error =
    BILLING_ERRORS[params.get("billing_err") ?? ""] ??
    PROMO_ERRORS[params.get("promo_err") ?? ""] ??
    PLAN_ERRORS[params.get("plan_err") ?? ""];
  return renderConsoleFor(db, req, deps, user, { notice, error });
}

/**
 * POST /console/plan — pick or change the tier your TRIAL mirrors, with NO
 * Stripe. Picking a tier only sets the internal `pending_plan` that drives which
 * caps the trial mirrors (entitlementPlanFor); it needs no card. Card entry
 * (checkout) is the separate `/billing/*` path.
 *
 * Trust boundary: session + CSRF + same-origin (the console write boundary).
 * Gating (canStartCheckout-shaped): only trial/expired accounts with no live
 * subscription reach the effect; a paid tier / live-sub uses the Stripe portal.
 *
 * THE LOAD-BEARING GUARD: only a live TRIAL user re-mirrors for FREE. An EXPIRED
 * user must NOT get a free paid tier here — that would silently un-freeze a
 * churned/lapsed account without payment. They're pointed at checkout
 * (`plan_err=reactivate`) instead; pending_plan/plan stay untouched (still
 * frozen). Effect for a trial: set `pending_plan=<tier>` (KEEP plan_downgrade_at
 * — changing tier mid-trial doesn't reset or extend the 30-day clock), then
 * re-apply the entitlement so the two-meter caps + voice update immediately
 * across every owned vault. The day-30 sweep still floors this trial to expired
 * (billing-lifecycle.ts #84 guard) — picking a paid tier is a preview, not a
 * free upgrade.
 */
export async function handleChoosePlanPost(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const user = await sessionUser(db, req, deps);
  if (!user) return redirectResponse("/login");
  const form = await req.formData();
  if (!verifyCsrfToken(req, form) || !isSameOriginRequest(req, resolveBoundOrigins(deps))) {
    return redirectResponse("/console?plan_err=session");
  }
  const raw = String(form.get("plan") ?? "");
  if (!isPlanId(raw) || !isPaidTier(raw)) {
    return redirectResponse("/console?plan_err=invalid");
  }
  // A paid tier / live subscriber changes plans through the Stripe portal, not
  // here (canStartCheckout: trial | expired only).
  if (!canStartCheckout(user.plan)) {
    return redirectResponse("/console?plan_err=already");
  }
  // THE GUARD: only a live trial re-mirrors for free. Expired → pay to reactivate.
  if (user.plan !== "trial") {
    return redirectResponse("/console?plan_err=reactivate");
  }
  // Set the chosen tier as the pending plan — KEEP the plan_downgrade_at clock.
  // CONDITIONAL WRITE AS GUARD (the runBillingSweep #84 pattern): the `plan !=
  // 'trial'` check above was read from the session snapshot, so the day-30 sweep
  // could FLOOR this user to `expired` in the read→write window. Pin the write to
  // `plan = 'trial'` so a raced-to-expired row can't be re-mirrored to a paid
  // tier — changes=0 means the sweep won reading, we must NOT push the chosen
  // tier's caps (that would un-freeze the now-expired vault at paid caps: the
  // exact bug). Point them at checkout instead, row untouched.
  const write = await db
    .prepare("UPDATE users SET pending_plan = ? WHERE id = ? AND plan = 'trial'")
    .bind(raw, user.id)
    .run();
  if ((write.meta.changes ?? 0) === 0) {
    return redirectResponse("/console?plan_err=reactivate");
  }
  // Re-push the (now chosen-tier) entitlement into every owned vault so caps +
  // voice update immediately (applyPlanToVaults reads the fresh row →
  // entitlementPlanFor(trial, <tier>) = <tier>'s spec). Best-effort per vault.
  await applyPlanToVaults(db, deps, user.id);
  return redirectResponse(`/console?plan_chosen=${encodeURIComponent(raw)}`);
}

export async function handleCreateVaultPost(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const user = await sessionUser(db, req, deps);
  if (!user) return redirectResponse("/login");
  const form = await req.formData();
  const rawName = String(form.get("name") ?? "");
  // Preserve the entered name across a validation-error re-render. (Legacy
  // clients may still POST `notes_app`/`first_note` from the old first-run
  // form — we simply never read them: extra fields are ignored, never a 400.)
  const firstRun: FirstRunValues = { name: rawName };
  if (!verifyCsrfToken(req, form) || !isSameOriginRequest(req, resolveBoundOrigins(deps))) {
    return consoleError(db, req, deps, user, "Your session expired. Please try again.", firstRun);
  }
  // Plan vault-count gate (plans.ts). `>=` grandfathers users already OVER a
  // cap (e.g. accounts predating plans): they keep and use every vault they
  // own — reads, tokens, everything — but can't create more until under the
  // cap. Benign TOCTOU: two concurrent creates can both pass the count — a
  // one-vault overshoot, reconciled by the same rule on the next attempt.
  // TODO(console-launch): the expired+zero-vault create trap — an expired user
  // with no vaults has vault_count=0, so 0 >= 0 always refuses here with the
  // at-cap message even though they've never made a vault. Give them a distinct
  // "pick a plan to create your first vault" path instead of the cap wall.
  const spec = PLAN_SPECS[user.plan];
  if ((await countVaultsForOwner(db, user.id)) >= spec.vault_count) {
    return consoleError(db, req, deps, user, vaultCapMessage(user.plan), firstRun);
  }
  try {
    const vault = await createVault(db, rawName, user.id, deps.now?.() ?? new Date());
    // Push the plan's storage cap + voice entitlement into the new vault's DO
    // config (the internal seam — vault-call.ts). A TRIAL pushes the CHOSEN
    // tier's spec when pending_plan names one (plans.ts entitlementPlanFor).
    // Best-effort by the same contract as the first note: a hiccup leaves the
    // DO on the (more generous) env default, never fails creation;
    // applyPlanToVaults / the backfill reconcile.
    await pushVaultCap(db, deps, user.id, vault.name, planEntitlement(entitlementPlanFor(user.plan, user.pendingPlan)));
    // Land the user straight in their notes, not back on the console (the
    // 2026-07-08 onboarding decision). 303 so the form POST resolves to a GET
    // on the cross-origin Notes deep-link. The console stays reachable for
    // plan/billing management.
    return redirectResponse(cardFor(vault.name, deps).notesUrl, {}, 303);
  } catch (err) {
    if (err instanceof VaultNameInvalidError) {
      const msg =
        err.reason === "reserved"
          ? "That name is reserved. Please choose another."
          : "Use 2–63 characters: lowercase letters, numbers, and hyphens (starting with a letter or number).";
      return consoleError(db, req, deps, user, msg, firstRun);
    }
    if (err instanceof VaultNameTakenError) {
      return consoleError(db, req, deps, user, "That vault name is already taken.", firstRun);
    }
    throw err;
  }
}

// --- the export door (launch-flow fix 1) -------------------------------------

/**
 * POST /console/vaults/export — the "export anytime" promise, delivered as a
 * console door: stream the vault worker's `GET /api/export` tarball back to
 * the browser as a download.
 *
 * Same trust boundary as every console write (session + CSRF + same-origin +
 * ownership), then THE SAME MINT SEAM as the packs button ({@link callVaultApi}
 * — a 60s aud-pinned first-party token, here `vault:<name>:read`, spent on one
 * server-side GET). Chosen over a 302-with-token: no bearer token ever lands
 * in a URL / browser history / access log, and the browser needs no CORS or
 * redirect handling — the POST's response IS the file
 * (`Content-Disposition: attachment`, streamed through, not buffered).
 *
 * An unowned/unknown vault gets the router-shaped 404 (one response for both —
 * no ownership oracle; only a crafted request can reach it, the UI only offers
 * owned vaults).
 */
export async function handleExportPost(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const user = await sessionUser(db, req, deps);
  if (!user) return redirectResponse("/login");
  const form = await req.formData();
  if (!verifyCsrfToken(req, form) || !isSameOriginRequest(req, resolveBoundOrigins(deps))) {
    return consoleError(db, req, deps, user, "Your session expired. Please try again.");
  }
  const vaultName = String(form.get("vault") ?? "").trim().toLowerCase();
  if (!vaultName || !(await userOwnsVault(db, user.id, vaultName))) {
    return routerNotFound();
  }

  let res: Response;
  try {
    res = await callVaultApi(db, deps, {
      userId: user.id,
      vaultName,
      method: "GET",
      apiPath: "/api/export",
      verb: "read",
    });
  } catch (err) {
    console.warn(
      `event=export_unreachable vault=${vaultName} error=${err instanceof Error ? err.message : String(err)}`,
    );
    return consoleError(db, req, deps, user, "Couldn't reach your vault just now. Please try again.");
  }
  if (!res.ok || !res.body) {
    console.warn(`event=export_failed vault=${vaultName} status=${res.status}`);
    return consoleError(db, req, deps, user, "Couldn't export just now. Please try again.");
  }

  // <vault>-export-<date>.tar — vault names are validated slugs ([a-z0-9-],
  // vaults.ts), so the filename needs no further escaping.
  const day = (deps.now?.() ?? new Date()).toISOString().slice(0, 10);
  const headers = new Headers({
    "content-type": "application/x-tar",
    "content-disposition": `attachment; filename="${vaultName}-export-${day}.tar"`,
  });
  const len = res.headers.get("content-length");
  if (len) headers.set("content-length", len);
  return new Response(res.body, { status: 200, headers });
}

// --- the import door (the other half of the portability promise) -------------

/**
 * The cloud import ceiling — must equal the vault worker's `MAX_IMPORT_BYTES`
 * (restore.ts). Separate Workers, no shared module; keep the two identical.
 */
// Exported for the cross-worker parity test (test-bun/import-limit-parity):
// this MUST equal the vault worker's MAX_IMPORT_BYTES (restore.ts).
export const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
const MAX_IMPORT_MIB = 50;

function importTooLargeMessage(): string {
  return `That export is over the ${MAX_IMPORT_MIB} MiB import limit. For a larger vault, write hello@parachute.computer — or use the CLI import on self-host.`;
}

/**
 * The friendly copy for a failed import forward/replay. We NEVER free the vault
 * name on failure, so the message reassures the caller: nothing was kept from
 * the upload, and the name is theirs — a retry reuses it (and the DO's blow-away
 * import converges). Vault names are validated slugs (`[a-z0-9-]`), so the name
 * needs no HTML escaping here.
 */
function importFailedMessage(vaultName: string): string {
  return (
    `Import failed — nothing was kept from the upload. The vault name "${vaultName}" ` +
    `is reserved for you; retrying the import will reuse it.`
  );
}

/**
 * Log a failed import forward. Wrapped so a logging failure can NEVER escalate a
 * handled import error into an unhandled 500 (this worker has no Hono onError).
 */
function logImportForwardFailed(userId: string, vaultName: string, detail: string): void {
  try {
    console.error(`event=import_forward_failed user=${userId} vault=${vaultName} error=${detail}`);
  } catch {
    /* a logging error must not propagate */
  }
}

/**
 * Render a friendly import-failure page, falling back to a dependency-free plain
 * response if the console re-render itself throws (its DB reads could hiccup, and
 * there is no Hono onError to catch an escaped exception). Either way the caller
 * sees the message, never a bare 500.
 */
async function importFailureResponse(
  db: D1Database,
  req: Request,
  deps: OAuthDeps,
  user: User,
  message: string,
): Promise<Response> {
  try {
    return await consoleError(db, req, deps, user, message);
  } catch (err) {
    logImportForwardFailed(user.id, "-", `render_failed:${err instanceof Error ? err.message : String(err)}`);
    return new Response(message, {
      status: 200,
      headers: { "content-type": "text/plain; charset=UTF-8" },
    });
  }
}

/**
 * POST /console/vaults/import — upload a Parachute export (.tar), get a NEW
 * vault with those notes. The other half of the export door: the portability
 * promise runs in both directions.
 *
 * The user-facing trust boundary mirrors the create door (an import CREATES a
 * vault): session + CSRF + same-origin + vault-name validation identical to
 * create + the plan vault-count cap (expired, vault_count 0, is refused here
 * exactly as create refuses it). Then: create (or, for a retry, REUSE) the
 * target vault → push the plan cap → forward the tar to the target DO's
 * `POST /api/internal/import` through the mint seam (first-party admin,
 * aud-pinned, 60s — same seam as restore/packs, carrying raw bytes). On success:
 * redirect with the note count for the success notice.
 *
 * Failure posture — restore-door parity, NEVER free the name: on ANY
 * forward/replay failure the ownership row PERSISTS. Freeing a name whose DO may
 * still hold the just-uploaded data would let ANOTHER account claim it via the
 * create door and — the welcome seed already spent — read the previous
 * uploader's notes (cross-account exposure, the exact class this door prevents).
 * The name stays the caller's; a retry re-imports into the SAME vault and
 * converges via the DO's blow-away purge.
 *
 * Reuse is GATED by `vaults.import_pending_at` (migration 0019): the create
 * branch stamps it, import success clears it, and ONLY a still-flagged row —
 * one that exists solely because a previous import attempt failed — may be
 * reused. A same-owner name WITHOUT the flag is a real, populated vault the
 * user typed by accident; blow-away importing into it would be same-account
 * data loss, so it gets the same "already taken" refusal as a cross-account
 * name. A flagged row whose earlier attempt PARTIALLY imported is exactly the
 * retry case — blow-away converges.
 *
 * Body-size: an oversize upload is refused early on Content-Length (before the
 * multipart parse), again on the extracted file size, and finally by the vault
 * worker's own 413 — three fences, one friendly message.
 */
export async function handleImportPost(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const user = await sessionUser(db, req, deps);
  if (!user) return redirectResponse("/login");

  // Refuse an oversize upload before parsing the multipart body (item 8). A
  // browser always sends Content-Length for a file POST; an absent/spoofed one
  // is caught again below and by the vault worker.
  const declaredLen = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLen) && declaredLen > MAX_IMPORT_BYTES) {
    return consoleError(db, req, deps, user, importTooLargeMessage());
  }

  const form = await req.formData();
  if (!verifyCsrfToken(req, form) || !isSameOriginRequest(req, resolveBoundOrigins(deps))) {
    return consoleError(db, req, deps, user, "Your session expired. Please try again.");
  }
  const rawName = String(form.get("vault_name") ?? "");
  const file = form.get("tarball");

  // workers-types under-types FormData.get as `string | null` (no File), but a
  // multipart file field is a Blob-like at runtime. Guard the string/null cases;
  // treat the remainder as a Blob (arrayBuffer() reads the bytes).
  if (file === null || typeof file === "string") {
    return consoleError(db, req, deps, user, "Choose a Parachute export file (.tar) to import.");
  }
  const buf = await (file as unknown as Blob).arrayBuffer();
  if (buf.byteLength === 0) {
    return consoleError(db, req, deps, user, "That file was empty — choose a Parachute export (.tar).");
  }
  if (buf.byteLength > MAX_IMPORT_BYTES) {
    return consoleError(db, req, deps, user, importTooLargeMessage());
  }

  // Resolve reuse-vs-create. We NEVER free a vault name on a failed import (see
  // the forward block below), so a RETRY must be able to reclaim the row it
  // already owns — but ONLY a row still flagged `import_pending_at` (created by
  // the import door, no successful import yet). A same-owner name WITHOUT the
  // flag is a real, populated vault: blow-away importing into it would be
  // same-account data loss, so it's refused exactly like a cross-account name.
  // A new name is created below, with name validation identical to the create
  // door.
  const now = deps.now?.() ?? new Date();
  const canonicalName = rawName.trim().toLowerCase();
  const existing = canonicalName ? await getVault(db, canonicalName) : null;
  if (existing && (existing.ownerUserId !== user.id || existing.importPendingAt === null)) {
    return consoleError(db, req, deps, user, "That vault name is already taken.");
  }

  let vaultName: string;
  if (existing) {
    // Retry into this caller's own still-import-pending row — reuse it. No NEW
    // vault, so the plan vault-count cap doesn't apply and the caps were already
    // pushed at its creation; the DO's blow-away purge makes the re-import
    // converge (a partial earlier attempt is exactly this case).
    vaultName = existing.name;
  } else {
    // A NEW vault — the plan vault-count gate, verbatim from the create door.
    // `>=` grandfathers accounts already over a cap; expired (vault_count 0) is
    // refused here exactly as create refuses it.
    const spec = PLAN_SPECS[user.plan];
    if ((await countVaultsForOwner(db, user.id)) >= spec.vault_count) {
      return consoleError(db, req, deps, user, vaultCapMessage(user.plan));
    }
    try {
      // `importPending: true` stamps `import_pending_at` atomically in the
      // insert — the flag that authorizes a retry to reuse this row (cleared
      // below on success). Atomic so a crash can't strand a flagless row.
      const vault = await createVault(db, rawName, user.id, now, { importPending: true });
      vaultName = vault.name;
    } catch (err) {
      if (err instanceof VaultNameInvalidError) {
        const msg =
          err.reason === "reserved"
            ? "That name is reserved. Please choose another."
            : "Use 2–63 characters: lowercase letters, numbers, and hyphens (starting with a letter or number).";
        return consoleError(db, req, deps, user, msg);
      }
      if (err instanceof VaultNameTakenError) {
        // TOCTOU: a concurrent create claimed it between getVault and here.
        return consoleError(db, req, deps, user, "That vault name is already taken.");
      }
      throw err;
    }
    // Push the plan's caps + voice entitlement (best-effort, as any creation).
    await pushVaultCap(db, deps, user.id, vaultName, planEntitlement(entitlementPlanFor(user.plan, user.pendingPlan)));
  }

  // Forward the tar. On ANY forward/replay failure we KEEP the ownership row —
  // NEVER free the name (see the handler docstring: a freed name whose DO may
  // still hold the just-uploaded data would be claimable by another account and
  // leak the previous uploader's notes). The name stays reserved for the caller;
  // a retry re-imports into the SAME vault and converges. Log loudly, and guard
  // the failure render so a logging/DB hiccup can't escalate a handled import
  // failure into an unhandled 500 (this worker has no Hono onError).
  let res: Response;
  try {
    res = await callVaultImport(db, deps, user.id, vaultName, buf);
  } catch (err) {
    logImportForwardFailed(user.id, vaultName, err instanceof Error ? err.message : String(err));
    return importFailureResponse(db, req, deps, user, importFailedMessage(vaultName));
  }
  if (!res.ok) {
    if (res.status === 413) {
      logImportForwardFailed(user.id, vaultName, "status=413");
      return importFailureResponse(db, req, deps, user, importTooLargeMessage());
    }
    logImportForwardFailed(user.id, vaultName, `status=${res.status}`);
    return importFailureResponse(db, req, deps, user, importFailedMessage(vaultName));
  }

  const summary = (await res.json().catch(() => ({}))) as {
    notes?: unknown;
    stats?: { notes_created?: unknown; skipped_attachments?: unknown };
  };
  const notes =
    typeof summary.notes === "number"
      ? summary.notes
      : typeof summary.stats?.notes_created === "number"
        ? summary.stats.notes_created
        : 0;
  const skipped = typeof summary.stats?.skipped_attachments === "number" ? summary.stats.skipped_attachments : 0;
  // Import succeeded — the vault now holds real content, so CLOSE the retry-
  // reuse gate (a later import naming this vault must get "already taken",
  // never a blow-away). Guarded: a D1 hiccup here must not turn a successful
  // import into a 500 — log loudly instead (the residual, a still-flagged
  // populated vault, is same-account-only and self-inflicted on reuse).
  try {
    await clearImportPending(db, vaultName, user.id);
  } catch (err) {
    logImportForwardFailed(user.id, vaultName, `flag_clear_failed:${err instanceof Error ? err.message : String(err)}`);
  }
  console.log(`event=import_completed vault=${vaultName} notes=${notes} skipped_attachments=${skipped}`);
  return redirectResponse(
    `/console?imported=${encodeURIComponent(vaultName)}&notes=${notes}&skipped=${skipped}`,
  );
}

// --- snapshot restore (Wave 4e — paid plans only) -----------------------------

/** The router's own 404 shape (the admin pattern) — for surfaces that don't
 *  exist for this caller: restore without the plan entitlement, export of a
 *  vault the session doesn't own. */
function routerNotFound(): Response {
  return new Response("404 Not Found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=UTF-8" },
  });
}

/**
 * POST /console/vaults/restore — restore a snapshot into a NEW vault.
 *
 * The user-facing trust boundary, in order:
 *   1. session; 2. PLAN entitlement (plans.ts `restore`) — free plans get the
 *   router-shaped 404, the surface doesn't exist for them (the admin
 *   pattern); 3. CSRF + same-origin; 4. ownership of the SOURCE vault;
 *   5. the snapshot key must be a mirrored restore point of that vault;
 *   6. the plan's vault-count cap (restore CREATES a vault — friendly
 *   refusal at the cap).
 *
 * Then: claim `<vault>-restored-<date>` (REUSED if this user already owns it
 * — the same-day-retry convergence; a retry never burns a second slot), push
 * the plan cap, and have the target DO replay the tarball
 * (snapshots.ts callVaultRestore → POST /api/internal/restore, blow-away
 * import). The SOURCE vault is never touched — the DO enforces that too
 * (restore_into_self → 400). A failed replay keeps the target row (its
 * content is the owner's own snapshot data; retrying converges) and reports
 * honestly.
 */
export async function handleRestorePost(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const user = await sessionUser(db, req, deps);
  if (!user) return redirectResponse("/login");
  const spec = PLAN_SPECS[user.plan];
  if (!spec.restore) return routerNotFound();

  const form = await req.formData();
  if (!verifyCsrfToken(req, form) || !isSameOriginRequest(req, resolveBoundOrigins(deps))) {
    return consoleError(db, req, deps, user, "Your session expired. Please try again.");
  }
  const vaultName = String(form.get("vault") ?? "").trim().toLowerCase();
  const key = String(form.get("key") ?? "");
  if (!vaultName || !(await userOwnsVault(db, user.id, vaultName))) {
    return consoleError(db, req, deps, user, "You can only restore a vault you own.");
  }
  if (!(await isKnownSnapshot(db, vaultName, key))) {
    return consoleError(db, req, deps, user, "That restore point wasn't recognized — reload and try again.");
  }

  const now = deps.now?.() ?? new Date();
  const targetName = restoredVaultName(vaultName, now);
  const existing = await getVault(db, targetName);
  if (existing && existing.ownerUserId !== user.id) {
    // Practically unreachable (restored-names derive from a vault the user
    // owns), but never restore into someone else's vault.
    return consoleError(db, req, deps, user, "Couldn't claim a name for the restored vault. Please try again tomorrow.");
  }
  if (!existing) {
    // Restore creates a NEW vault — it counts against the plan's vault limit
    // exactly like any other creation (same `>=` grandfathering rule).
    if ((await countVaultsForOwner(db, user.id)) >= spec.vault_count) {
      return consoleError(db, req, deps, user, restoreAtCapMessage(user.plan));
    }
    try {
      await createVault(db, targetName, user.id, now);
    } catch (err) {
      if (err instanceof VaultNameTakenError || err instanceof VaultNameInvalidError) {
        return consoleError(db, req, deps, user, "Couldn't claim a name for the restored vault. Please try again.");
      }
      throw err;
    }
    // Same best-effort entitlement push as any vault creation (a miss leaves the
    // vault on its prior caps; applyPlanToVaults reconciles). Trial mirrors the
    // chosen tier (entitlementPlanFor), same as the create path.
    await pushVaultCap(db, deps, user.id, targetName, planEntitlement(entitlementPlanFor(user.plan, user.pendingPlan)));
  }

  try {
    await callVaultRestore(db, deps, user.id, targetName, vaultName, key);
  } catch (err) {
    console.warn(
      `event=restore_failed vault=${vaultName} target=${targetName} error=${err instanceof Error ? err.message : String(err)}`,
    );
    return consoleError(
      db,
      req,
      deps,
      user,
      `Restore didn't complete — please try again in a moment. (Retrying reuses "${targetName}"; it never touches "${vaultName}".)`,
    );
  }
  console.log(`event=restore_completed vault=${vaultName} target=${targetName}`);
  return redirectResponse(`/console?restored=${encodeURIComponent(targetName)}`);
}

// --- the getting-started checklist ------------------------------------------

/**
 * Where each checklist door goes after the mark-done write. Doors ① ② ⑤
 * navigate out to the Notes PWA; the expandables (③ ④) and the dismissal
 * land back on the console. Computed against the user's FIRST vault (the one
 * the checklist card renders for).
 */
function checklistDestination(item: string, card: ConsoleVaultCard): string {
  if (item === "open-notes") return card.notesUrl;
  // Write-a-note lands on the new-note editor, not the notes home — the door
  // should open onto a blank page with the pen already in hand.
  if (item === "write-note") return card.writeUrl;
  if (item === "import-notes") return card.importUrl;
  return "/console";
}

/**
 * POST /console/checklist — mark a getting-started item done (or `hidden` to
 * dismiss the whole card), then 302 to the item's destination. The door IS the
 * mark: clicking "Open your notes" records open-notes and takes you there in
 * one gesture (form target opens the PWA in a new tab; the expandables post
 * via a tiny fetch on first open). Same trust boundary as every console
 * write: session + CSRF + same-origin.
 */
export async function handleChecklistPost(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const user = await sessionUser(db, req, deps);
  if (!user) return redirectResponse("/login");
  const form = await req.formData();
  if (!verifyCsrfToken(req, form) || !isSameOriginRequest(req, resolveBoundOrigins(deps))) {
    return consoleError(db, req, deps, user, "Your session expired. Please try again.");
  }
  const item = String(form.get("item") ?? "");
  if (!isChecklistItem(item)) return redirectResponse("/console");
  const vaults = await listVaultsForOwner(db, user.id);
  // No vault yet → nothing for a door to open; don't record phantom progress.
  if (vaults.length === 0) return redirectResponse("/console");
  await markChecklistItem(db, user.id, item, deps.now?.() ?? new Date());
  return redirectResponse(checklistDestination(item, cardFor(vaults[0]!.name, deps)));
}

/**
 * POST /console/checklist/restore — bring back a dismissed checklist card
 * (the quiet "Show setup guide" footer link). Deletes the reserved `hidden`
 * row; done rows survive, so progress renders exactly where it was left.
 * Same trust boundary as every console write: session + CSRF + same-origin.
 */
export async function handleChecklistRestorePost(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const user = await sessionUser(db, req, deps);
  if (!user) return redirectResponse("/login");
  const form = await req.formData();
  if (!verifyCsrfToken(req, form) || !isSameOriginRequest(req, resolveBoundOrigins(deps))) {
    return consoleError(db, req, deps, user, "Your session expired. Please try again.");
  }
  await unhideChecklist(db, user.id);
  return redirectResponse("/console");
}

// --- seed packs (the "Building a surface?" button) --------------------------

/**
 * Packs the console offers. Only `surface-starter` today (ratified 2026-07-02:
 * it's out of the default seed, added on demand). The vault worker's
 * POST /api/packs/:name is the general seam; this allowlist is just what the
 * console UI puts a button on.
 */
const CONSOLE_PACKS = new Set(["surface-starter"]);

/**
 * THE MINT SEAM lives in vault-call.ts (shared with the plan-cap push): mint a
 * first-party 60s aud-pinned `vault:<name>:write` token, spend it on one POST.
 * This wrapper keeps the console's write-verb call sites one line.
 */
async function postVaultApi(
  db: D1Database,
  deps: OAuthDeps,
  userId: string,
  vaultName: string,
  apiPath: string,
  jsonBody?: unknown,
): Promise<Response> {
  return callVaultApi(db, deps, { userId, vaultName, method: "POST", apiPath, verb: "write", jsonBody });
}

/**
 * POST /console/packs — apply a seed pack to one of the user's vaults, via the
 * vault worker's POST /api/packs/:name through the shared mint seam
 * ({@link postVaultApi}). The user-facing trust boundary: session cookie +
 * CSRF + same-origin + ownership (`userOwnsVault` — the exact predicate behind
 * `unownedNamedVaults` on the OAuth mint paths) — identical to creating the
 * vault itself.
 */
export async function handleAddPackPost(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const user = await sessionUser(db, req, deps);
  if (!user) return redirectResponse("/login");
  const form = await req.formData();
  if (!verifyCsrfToken(req, form) || !isSameOriginRequest(req, resolveBoundOrigins(deps))) {
    return consoleError(db, req, deps, user, "Your session expired. Please try again.");
  }
  const vaultName = String(form.get("vault") ?? "").trim().toLowerCase();
  const pack = String(form.get("pack") ?? "");
  if (!CONSOLE_PACKS.has(pack)) {
    return consoleError(db, req, deps, user, "Unknown guide.");
  }
  // Ownership chokepoint — same predicate the OAuth mint paths enforce.
  if (!vaultName || !(await userOwnsVault(db, user.id, vaultName))) {
    return consoleError(db, req, deps, user, "You can only add guides to a vault you own.");
  }

  let res: Response;
  try {
    res = await postVaultApi(db, deps, user.id, vaultName, `/api/packs/${encodeURIComponent(pack)}`);
  } catch (err) {
    console.warn(
      `event=pack_apply_unreachable vault=${vaultName} pack=${pack} error=${err instanceof Error ? err.message : String(err)}`,
    );
    return consoleError(db, req, deps, user, "Couldn't reach your vault just now. Please try again.");
  }
  if (!res.ok) {
    console.warn(`event=pack_apply_failed vault=${vaultName} pack=${pack} status=${res.status}`);
    return consoleError(db, req, deps, user, "Couldn't add the guide just now. Please try again.");
  }
  // Idempotent on the vault side — "already there" is also a 200, so re-clicks
  // land on the same success notice instead of an error.
  return redirectResponse(`/console?pack_added=${encodeURIComponent(vaultName)}`);
}

async function consoleError(
  db: D1Database,
  req: Request,
  deps: OAuthDeps,
  user: User,
  message: string,
  firstRun?: FirstRunValues,
): Promise<Response> {
  return renderConsoleFor(db, req, deps, user, { error: message, firstRun });
}

// Re-exported for index.ts route wiring symmetry.
export { SESSION_COOKIE };
