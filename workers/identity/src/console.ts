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
  listVaultsForOwner,
  userOwnsVault,
} from "./vaults.ts";
import { PLAN_SPECS, vaultCapMessage } from "./plans.ts";
import { callVaultApi, pushVaultCap } from "./vault-call.ts";
import {
  getChecklistState,
  isChecklistItem,
  markChecklistItem,
  setNotesApp,
} from "./checklist.ts";
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
  if (!user || !(await verifyPassword(user, password))) {
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
    // (or skip if already connected), then land on /import.
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
  // The checklist card renders once a vault exists, until dismissed. Its doors
  // open the FIRST (oldest) vault — the one the first-run flow created.
  let checklist = null;
  if (cards.length > 0) {
    const state = await getChecklistState(db, user.id);
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
      firstRun: opts.firstRun,
      plan: user.plan,
      // At (or over — grandfathered) the plan's vault count: the create form
      // gives way to the friendly at-cap note. The POST handler is the real
      // gate; this just keeps the UI honest.
      atVaultCap: cards.length >= PLAN_SPECS[user.plan].vault_count,
    }),
    200,
    csrfExtra(csrf.setCookie),
  );
}

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
  const notice = created
    ? `Your vault "${created}" is ready — open your notes, or connect your AI below.`
    : packVault
      ? `Surface Starter added to ${packVault} — ask your connected AI to read it.`
      : undefined;
  return renderConsoleFor(db, req, deps, user, { notice });
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
    // Push the plan's storage cap into the new vault's DO config (the
    // internal seam — vault-call.ts). Best-effort by the same contract as the
    // first note: a hiccup leaves the DO on the (more generous) env default,
    // never fails creation; applyPlanToVaults / the backfill reconcile.
    await pushVaultCap(db, deps, user.id, vault.name, spec.total_bytes);
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

// --- the getting-started checklist ------------------------------------------

/**
 * Where each checklist door goes after the mark-done write. Doors ① ② ⑤
 * navigate out to the Notes PWA; the expandables (③ ④) and the dismissal
 * land back on the console. Computed against the user's FIRST vault (the one
 * the checklist card renders for).
 */
function checklistDestination(item: string, card: ConsoleVaultCard): string {
  if (item === "open-notes" || item === "write-note") return card.notesUrl;
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
