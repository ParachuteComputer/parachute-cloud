/**
 * The self-serve console — accounts + vaults, on the Identity Worker itself
 * (it already owns users, sessions, cookies, and the rendered-HTML surface).
 *
 * Routes (all pure `(db, req, deps)` like the OAuth handlers):
 *   GET  /signup           create-account form
 *   POST /signup           create user + session → /console
 *   GET  /login            console sign-in form
 *   POST /login            verify + session → /console
 *   POST /logout           clear session → /login
 *   GET  /console          my vaults + create form + connect cards
 *   POST /console/vaults   claim a vault name → /console?created=<name>
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
  createVault,
  listVaultsForOwner,
} from "./vaults.ts";
import {
  type ConsoleVaultCard,
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
    mcpUrl: `${base}/mcp`,
    restUrl: `${base}/api`,
    connectCmd: `claude mcp add --transport http parachute-${name} ${base}/mcp`,
  };
}

export async function handleConsoleGet(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const user = await sessionUser(db, req, deps);
  if (!user) return redirectResponse("/login");
  const vaults = await listVaultsForOwner(db, user.id);
  const created = new URL(req.url).searchParams.get("created");
  const notice = created ? `Your vault "${created}" is ready — open your notes, or connect your AI below.` : undefined;
  const csrf = ensureCsrfToken(req);
  return htmlResponse(
    renderConsole({
      email: user.email,
      vaults: vaults.map((v) => cardFor(v.name, deps)),
      csrfToken: csrf.token,
      notice,
    }),
    200,
    csrfExtra(csrf.setCookie),
  );
}

export async function handleCreateVaultPost(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const user = await sessionUser(db, req, deps);
  if (!user) return redirectResponse("/login");
  const form = await req.formData();
  if (!verifyCsrfToken(req, form) || !isSameOriginRequest(req, resolveBoundOrigins(deps))) {
    return consoleError(db, req, deps, user, "Your session expired. Please try again.");
  }
  const rawName = String(form.get("name") ?? "");
  try {
    const vault = await createVault(db, rawName, user.id, deps.now?.() ?? new Date());
    return redirectResponse(`/console?created=${encodeURIComponent(vault.name)}`);
  } catch (err) {
    if (err instanceof VaultNameInvalidError) {
      const msg =
        err.reason === "reserved"
          ? "That name is reserved. Please choose another."
          : "Use 2–63 characters: lowercase letters, numbers, and hyphens (starting with a letter or number).";
      return consoleError(db, req, deps, user, msg);
    }
    if (err instanceof VaultNameTakenError) {
      return consoleError(db, req, deps, user, "That vault name is already taken.");
    }
    throw err;
  }
}

async function consoleError(
  db: D1Database,
  req: Request,
  deps: OAuthDeps,
  user: User,
  message: string,
): Promise<Response> {
  const vaults = await listVaultsForOwner(db, user.id);
  const csrf = ensureCsrfToken(req);
  return htmlResponse(
    renderConsole({
      email: user.email,
      vaults: vaults.map((v) => cardFor(v.name, deps)),
      csrfToken: csrf.token,
      error: message,
    }),
    200,
    csrfExtra(csrf.setCookie),
  );
}

// Re-exported for index.ts route wiring symmetry.
export { SESSION_COOKIE };
