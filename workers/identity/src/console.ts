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
 *                            vault" + two optional research questions);
 *                            otherwise the checklist card + vault cards +
 *                            create form
 *   POST /console/vaults     claim a vault name → /console?created=<name>.
 *                            Also carries the OPTIONAL first-run extras:
 *                            `notes_app` (research, stored on the user row) and
 *                            `first_note` (written INTO the new vault as the
 *                            user's real first note — best-effort, see
 *                            writeFirstNote)
 *   POST /console/packs      apply a seed pack to an owned vault (server-side
 *                            call to the vault worker with an internally minted
 *                            scoped token) → /console?pack_added=<name>
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
  countVaultsForOwner,
  createVault,
  getVault,
  listVaultsForOwner,
  userOwnsVault,
} from "./vaults.ts";
import { PLAN_SPECS, restoreAtCapMessage, transcriptionEntitlement, vaultCapMessage } from "./plans.ts";
import { callVaultApi, pushVaultCap } from "./vault-call.ts";
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
  setNotesApp,
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
  const csrf = ensureCsrfToken(req);
  return htmlResponse(
    renderConsole({
      email: user.email,
      vaults: cards,
      csrfToken: csrf.token,
      error: opts.error,
      notice: opts.notice,
      checklist,
      // Dismissed → the quiet "Show setup guide" footer link brings it back.
      showChecklistRestore: checklistHidden,
      firstRun: opts.firstRun,
      plan: user.plan,
      totalUsedBytes,
      // Billing doors (Wave 4d): Upgrade for free users / Manage billing for
      // paid users WITH a Stripe customer (comped accounts have none) — both
      // only while billing is configured (billing-config.ts; unconfigured =
      // today's deploy = the teaser stays and no billing UI exists).
      billingConfigured: deps.billingConfigured === true,
      voiceBillingConfigured: deps.voiceBillingConfigured === true,
      // Interim MOCK path (mock-payments): non-prod + no real Stripe (or the
      // explicit MOCK_BILLING flag). Upgrade buttons then POST the mock
      // endpoint + a "test mode" label; ALWAYS false in production.
      mockBillingEnabled: deps.mockBillingEnabled === true,
      hasBillingAccount: user.stripeCustomerId !== null,
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
  already: "You're already on the Parachute plan — use Manage billing to make changes.",
  "no-billing": "This account has no billing profile to manage. Write hello@parachute.computer if something looks off.",
  stripe: "Couldn't reach the payment provider just now. Please try again in a moment.",
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
  const notice = created
    ? `Your vault "${created}" is ready — open your notes, or connect your AI below.`
    : restoredVault
      ? `Snapshot restored into "${restoredVault}" — a new vault; the original is untouched. Heads up: v1 snapshots don't include attachment files, so notes and their attachment references are back but the files themselves aren't.`
      : packVault
      ? `Surface Starter added to ${packVault} — ask your connected AI to read it.`
      : params.get("mock_upgraded")
        ? `Test purchase complete — no real charge. You're on the ${PLAN_SPECS[user.plan].label} plan now (mock billing; the caps and any voice entitlement lifted exactly as a real payment would).`
        : params.get("upgraded")
          ? "Thanks — payment received. Your Parachute plan activates the moment Stripe's confirmation lands (usually seconds)."
          : params.get("checkout_canceled")
            ? "Checkout canceled — nothing changed."
            : undefined;
  const error = BILLING_ERRORS[params.get("billing_err") ?? ""];
  return renderConsoleFor(db, req, deps, user, { notice, error });
}

export async function handleCreateVaultPost(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const user = await sessionUser(db, req, deps);
  if (!user) return redirectResponse("/login");
  const form = await req.formData();
  const rawName = String(form.get("name") ?? "");
  // First-run extras — both OPTIONAL (the questions are research, not a wall).
  const notesApp = String(form.get("notes_app") ?? "");
  const firstNote = String(form.get("first_note") ?? "");
  // Preserve the user's answers across a validation error re-render.
  const firstRun: FirstRunValues = { name: rawName, notesApp, firstNote };
  if (!verifyCsrfToken(req, form) || !isSameOriginRequest(req, resolveBoundOrigins(deps))) {
    return consoleError(db, req, deps, user, "Your session expired. Please try again.", firstRun);
  }
  // Plan vault-count gate (plans.ts). `>=` grandfathers users already OVER a
  // cap (e.g. accounts predating plans): they keep and use every vault they
  // own — reads, tokens, everything — but can't create more until under the
  // cap. Benign TOCTOU: two concurrent creates can both pass the count — a
  // one-vault overshoot, reconciled by the same rule on the next attempt.
  const spec = PLAN_SPECS[user.plan];
  if ((await countVaultsForOwner(db, user.id)) >= spec.vault_count) {
    return consoleError(db, req, deps, user, vaultCapMessage(user.plan), firstRun);
  }
  try {
    const vault = await createVault(db, rawName, user.id, deps.now?.() ?? new Date());
    // Push the plan's storage cap + voice entitlement into the new vault's DO
    // config (the internal seam — vault-call.ts). Best-effort by the same
    // contract as the first note: a hiccup leaves the DO on the (more generous)
    // env default, never fails creation; applyPlanToVaults / the backfill reconcile.
    await pushVaultCap(db, deps, user.id, vault.name, spec.total_bytes, transcriptionEntitlement(user.plan));
    // (a) research answer → user row. Allowlisted inside; unknown values no-op.
    if (notesApp) await setNotesApp(db, user.id, notesApp);
    // (b) their first note → INTO the new vault, verbatim. Best-effort by
    // contract: a vault-worker hiccup must never fail vault creation.
    if (firstNote.trim().length > 0) await writeFirstNote(db, deps, user, vault.name, firstNote);
    return redirectResponse(`/console?created=${encodeURIComponent(vault.name)}`);
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

/** Path of the note the first-run answer (b) becomes in the user's new vault. */
const FIRST_NOTE_PATH = "My first note";

/**
 * Write the first-run "first thing you want your AI to remember" into the
 * freshly created vault as a REAL note (path "My first note", content
 * verbatim), through the same mint seam the packs button uses (60s
 * `vault:<name>:write`, aud-pinned — see {@link handleAddPackPost}).
 *
 * BEST-EFFORT by contract: this runs after the vault row is committed, and a
 * failure (vault worker down, cold-start hiccup) logs a structured warning and
 * returns — vault creation MUST still succeed. This request is typically the
 * vault DO's first materialization, so the welcome seed runs in the same
 * breath and the user's note joins the seeded web.
 */
async function writeFirstNote(
  db: D1Database,
  deps: OAuthDeps,
  user: User,
  vaultName: string,
  content: string,
): Promise<void> {
  try {
    const res = await postVaultApi(db, deps, user.id, vaultName, "/api/notes", {
      path: FIRST_NOTE_PATH,
      content,
    });
    if (!res.ok) {
      console.warn(`event=first_note_write_failed vault=${vaultName} status=${res.status}`);
    }
  } catch (err) {
    console.warn(
      `event=first_note_write_failed vault=${vaultName} error=${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// --- snapshot restore (Wave 4e — paid plans only) -----------------------------

/** Mirrors the admin router's own 404 — the restore surface doesn't exist for
 *  plans without the entitlement (free), same as it doesn't for anonymous. */
function restoreNotFound(): Response {
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
  if (!spec.restore) return restoreNotFound();

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
    // Same best-effort cap + voice-entitlement push as any vault creation (a
    // miss leaves the more-generous env default; applyPlanToVaults reconciles).
    await pushVaultCap(db, deps, user.id, targetName, spec.total_bytes, transcriptionEntitlement(user.plan));
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
