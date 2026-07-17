/**
 * /oauth/authorize — the auth-code entrypoint (GET) + the login/consent form
 * posts (POST). Reproduces the hub's flow, minus the multi-user vault-assignment
 * matrix (the cloud has no per-user vault ownership table; isolation is
 * structural). PKCE S256 is mandatory; a pending client auto-approves on a valid
 * session (single-consent); prior grants skip consent; resource/`vault=` bind the
 * consent + minted scopes to a named vault.
 */
import { issueAuthCode } from "./auth-codes.ts";
import {
  narrowResourceVaultScopes,
  narrowVaultScopes,
  resolveResourceVault,
  unnamedVaultVerbs,
} from "./audience.ts";
import { approveClient, getClient, requireRegisteredRedirectUri } from "./clients.ts";
import { isCoveredByGrant, recordGrant } from "./grants.ts";
import { unownedNamedVaults } from "./vaults.ts";
import { SESSION_COOKIE, buildSessionCookie, createSession, findActiveSession, parseSessionCookie } from "./sessions.ts";
import { getUserByEmail, getUserById, needsRehash, setPassword, verifyPassword } from "./users.ts";
import { isTotpEnrolled } from "./two-factor.ts";
import { buildPendingLoginCookie, createPendingLogin } from "./pending-login.ts";
import { clearLoginFailures, clientIp, isLoginLocked, loginKey, recordLoginFailure } from "./rate-limit.ts";
import { ensureCsrfToken, verifyCsrfToken } from "./csrf.ts";
import { type AuthorizeParams, describeScopes, renderConsent, renderError, renderLogin, renderRedirectBridge } from "./ui.ts";
import {
  type OAuthDeps,
  findNonRequestableScopes,
  htmlResponse,
  isCrossOrigin,
  isSameOriginRequest,
  oauthErrorRedirect,
  redirectResponse,
  resolveBoundOrigins,
} from "./oauth-shared.ts";

const VAULT_NAME_RE = /^[a-zA-Z0-9_-]+$/;

function htmlError(title: string, message: string, status: number): Response {
  return htmlResponse(renderError({ title, message }), status);
}

/**
 * Vault-ownership gate: a user may only authorize a vault they OWN. Returns an
 * `invalid_scope` error redirect naming the unowned vault(s), or null when every
 * named vault in `scopes` is owned (or none is named). Called before consent for
 * already-named vaults and at consent submit once the pick has been resolved.
 */
async function denyUnownedVaults(
  db: D1Database,
  userId: string,
  scopes: readonly string[],
  params: AuthorizeParams,
): Promise<Response | null> {
  const unowned = await unownedNamedVaults(db, userId, scopes);
  if (unowned.length === 0) return null;
  return oauthErrorRedirect(
    params.redirectUri,
    "invalid_scope",
    `you do not own ${unowned.length > 1 ? "these vaults" : "the vault"}: ${unowned.join(", ")}`,
    params.state,
  );
}

function buildParams(get: (k: string) => string | null): AuthorizeParams | { error: string } {
  const req = (k: string) => {
    const v = get(k);
    return v && v.length > 0 ? v : null;
  };
  const clientId = req("client_id");
  const redirectUri = req("redirect_uri");
  const responseType = req("response_type");
  const codeChallenge = req("code_challenge");
  const codeChallengeMethod = req("code_challenge_method");
  if (!clientId) return { error: "missing client_id" };
  if (!redirectUri) return { error: "missing redirect_uri" };
  if (!responseType) return { error: "missing response_type" };
  if (!codeChallenge) return { error: "missing code_challenge" };
  if (!codeChallengeMethod) return { error: "missing code_challenge_method" };
  return {
    clientId,
    redirectUri,
    responseType,
    scope: get("scope") ?? "",
    codeChallenge,
    codeChallengeMethod,
    state: get("state"),
    resource: get("resource"),
    vault: get("vault"),
  };
}

function paramsFromQuery(url: URL): AuthorizeParams | { error: string } {
  return buildParams((k) => url.searchParams.get(k));
}

function paramsFromForm(form: FormData): AuthorizeParams | { error: string } {
  return buildParams((k) => {
    const v = form.get(k);
    return typeof v === "string" ? v : null;
  });
}

/**
 * Authorize params carried on a NON-authorize form POST (the magic-link send
 * from the authorize login page — auth-handlers.ts), or null when the form
 * carries none / an incomplete set. Same field vocabulary as the login/consent
 * round-trip (ui.ts hiddenParams); incomplete → null rather than an error
 * because for that caller the params are an optional rider, not the request.
 */
export function authorizeParamsFromForm(form: FormData): AuthorizeParams | null {
  const parsed = paramsFromForm(form);
  return "error" in parsed ? null : parsed;
}

async function issueAuthCodeRedirect(
  db: D1Database,
  params: AuthorizeParams,
  scopes: string[],
  userId: string,
  deps: OAuthDeps,
): Promise<Response> {
  const code = await issueAuthCode(db, {
    clientId: params.clientId,
    userId,
    redirectUri: params.redirectUri,
    scopes,
    codeChallenge: params.codeChallenge,
    codeChallengeMethod: params.codeChallengeMethod,
    now: deps.now,
  });
  const u = new URL(params.redirectUri);
  u.searchParams.set("code", code.code);
  if (params.state) u.searchParams.set("state", params.state);
  return redirectResponse(u.toString());
}

/**
 * The shared authorize core. `params` is mutated in place by resource-narrowing
 * so the login round-trip + consent render see the narrowed scope. `req` carries
 * only the cookies (session + csrf).
 */
async function authorizeCore(
  db: D1Database,
  req: Request,
  params: AuthorizeParams,
  deps: OAuthDeps,
): Promise<Response> {
  const client = await getClient(db, params.clientId);
  if (!client) {
    return htmlError("Unknown application", `No client is registered for client_id ${params.clientId}.`, 400);
  }

  // RFC 8707 resource binding: narrow the scope to the named vault BEFORE any
  // consent/mint so the whole flow sees the narrowed set.
  const boundVault = resolveResourceVault(params.resource, {
    boundOrigins: resolveBoundOrigins(deps),
    vaultBaseDomain: deps.vaultBaseDomain,
    vaultOrigin: deps.vaultOrigin,
  });
  if (boundVault) {
    params.scope = narrowResourceVaultScopes(params.scope.split(" ").filter((s) => s.length > 0), boundVault).join(" ");
  }

  // Validate redirect_uri BEFORE redirecting any protocol error to it (RFC
  // 6749 §4.1.2.1 — an unvalidated redirect_uri error is shown, never redirected).
  try {
    requireRegisteredRedirectUri(client, params.redirectUri);
  } catch {
    return htmlError("Redirect mismatch", "The redirect_uri does not match any URI registered for this app.", 400);
  }
  if (params.responseType !== "code") {
    return oauthErrorRedirect(params.redirectUri, "unsupported_response_type", "only response_type=code is supported", params.state);
  }
  if (params.codeChallengeMethod !== "S256") {
    return oauthErrorRedirect(params.redirectUri, "invalid_request", "PKCE S256 is required", params.state);
  }

  const sessionId = parseSessionCookie(req.headers.get("cookie"));
  const session = sessionId ? await findActiveSession(db, sessionId, deps.now?.() ?? new Date()) : null;

  // Pending client: single-consent — a session auto-approves it, else login.
  if (client.status !== "approved") {
    if (!session) return renderLoginPage(req, params);
    await approveClient(db, client.clientId);
  }

  // Operator-only scope gate.
  const requestedScopes = params.scope.split(" ").filter((s) => s.length > 0);
  const blocked = findNonRequestableScopes(requestedScopes);
  if (blocked.length > 0) {
    return oauthErrorRedirect(
      params.redirectUri,
      "invalid_scope",
      `requested scopes are not available via the public authorization endpoint: ${blocked.join(", ")}`,
      params.state,
    );
  }

  if (!session) return renderLoginPage(req, params);

  // Ownership gate for ALREADY-named vaults (resource-bound or directly-scoped)
  // — refuse before consent so the user never approves a vault they can't get.
  // The unnamed `vault:<verb>` + pick case is gated at consent submit; the token
  // endpoint re-checks as defense-in-depth.
  const ownershipDenied = await denyUnownedVaults(db, session.userId, requestedScopes, params);
  if (ownershipDenied) return ownershipDenied;

  // Skip-consent when a prior grant covers the request. Unnamed vault verbs
  // always render consent (the vault choice isn't recorded literally).
  const hasUnnamedVault = unnamedVaultVerbs(requestedScopes).length > 0;
  if (!hasUnnamedVault && (await isCoveredByGrant(db, session.userId, client.clientId, requestedScopes))) {
    return issueAuthCodeRedirect(db, params, requestedScopes, session.userId, deps);
  }

  const lockedVault = params.vault && VAULT_NAME_RE.test(params.vault) ? params.vault : null;
  const csrf = ensureCsrfToken(req);
  const extra: Record<string, string> = csrf.setCookie ? { "set-cookie": csrf.setCookie } : {};
  // The session is already proven live (findActiveSession JOINs users WHERE
  // suspended_at IS NULL), so the user row always resolves here — `?? ""` is
  // defensive only, matching the codebase's convention elsewhere.
  const consentUser = await getUserById(db, session.userId);
  return htmlResponse(
    renderConsent({
      params,
      csrfToken: csrf.token,
      clientName: client.clientName ?? client.clientId,
      scopeDescriptions: describeScopes(requestedScopes),
      lockedVault,
      needsVaultPick: hasUnnamedVault && !lockedVault,
      // From CONFIG (deps.issuer), never from the request — the "issued by
      // <host>" trust line on the consent page (#42).
      issuerHost: new URL(deps.issuer).host,
      // Auth redesign §3 move 1: "Signed in as {email} · Not you?" — the
      // ceremony now names the account approving the grant. `notYouNext`
      // reconstructs THIS exact pending authorize URL, so a "Not you?"
      // logout lands back here (no session → the login page, params intact)
      // and the connector request resumes without any new machinery.
      email: consentUser?.email ?? "",
      notYouNext: buildAuthorizeUrl(deps.issuer, params),
    }),
    200,
    extra,
  );
}

function renderLoginPage(req: Request, params: AuthorizeParams, error?: string): Response {
  const csrf = ensureCsrfToken(req);
  const extra: Record<string, string> = csrf.setCookie ? { "set-cookie": csrf.setCookie } : {};
  // Errors on this page today only come from the password submit path, so an
  // error render opens the password disclosure (magic-send errors re-render via
  // auth-handlers.ts with showPassword: false).
  return htmlResponse(renderLogin({ params, csrfToken: csrf.token, error, showPassword: Boolean(error) }), 200, extra);
}

export async function handleAuthorizeGet(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const parsed = paramsFromQuery(new URL(req.url));
  if ("error" in parsed) return htmlError("Invalid authorization request", parsed.error, 400);
  return authorizeCore(db, req, parsed, deps);
}

/**
 * Chrome enforces `form-action 'self'` against a form POST's ULTIMATE
 * redirect destination, not just the form's action (oauth-shared.ts —
 * {@link isCrossOrigin}, ui.ts `renderRedirectBridge`). Every response this
 * endpoint can produce for a POST funnels through here: the consent
 * approve/deny/error redirects (all target the CLIENT's redirect_uri —
 * cross-origin by definition) and, via `handleLoginSubmit`'s downstream
 * `authorizeCore` call, the rarer skip-consent-on-login case (a prior grant
 * already covers this client, so login lands straight on the code redirect
 * instead of the consent page). A same-origin response (the rendered login/
 * consent HTML, or `/login/2fa`) passes through unchanged — only a 30x whose
 * Location is cross-origin gets bridged. The GET path (`handleAuthorizeGet`)
 * never routes through here and keeps its direct redirects (proven safe —
 * GET-triggered navigations are unconstrained by `form-action`).
 *
 * This is also THE post-consent contract fix (auth redesign §5, task #34):
 * when actually bridging, the client's display name (already resolved for
 * the consent render) rides into `renderRedirectBridge` so the page names
 * who you're being returned to and carries the 3-second watchdog instead of
 * a bare "Redirecting…" spinner — the exact dead end a connector client can
 * leave a disposable tab in after its own server already exchanged the code.
 * The lookup only runs when actually bridging (cross-origin 3xx) — the
 * common case (a same-origin render, or an error) never pays for it.
 */
/** @cloudflare/workers-types doesn't type getSetCookie(), but workerd supports it (the test/*.ts convention — auth.test.ts, console.test.ts, account-session.test.ts). */
function getSetCookies(headers: Headers): string[] {
  return (headers as unknown as { getSetCookie(): string[] }).getSetCookie();
}

async function bridgeIfCrossOrigin(res: Response, issuer: string, db: D1Database, clientId: string): Promise<Response> {
  if (res.status < 300 || res.status >= 400) return res;
  const location = res.headers.get("location");
  if (!location || !isCrossOrigin(location, issuer)) return res;
  const client = clientId ? await getClient(db, clientId) : null;
  // `handleLoginSubmit` can layer a fresh session `set-cookie` onto a response
  // that turns out to need bridging (the skip-consent-on-login case) —
  // htmlResponse builds an entirely NEW Response, so any cookie must be
  // carried over explicitly or the mint is silently dropped. `getSetCookie()`
  // (not `.get()`, which comma-JOINS multiple Set-Cookie values — invalid for
  // cookies, whose own values can legitimately contain commas, e.g. an
  // `Expires=Wed, 21 Oct...` attribute) + `.append()` preserves each as its
  // own header line, correct for 0, 1, or N cookies.
  const bridged = htmlResponse(
    renderRedirectBridge(new URL(location, issuer).toString(), { clientName: client?.clientName ?? undefined }),
    200,
    { "cache-control": "no-store" }, // the page carries a one-time code — defense-in-depth
  );
  for (const cookie of getSetCookies(res.headers)) bridged.headers.append("set-cookie", cookie);
  return bridged;
}

export async function handleAuthorizePost(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const form = await req.formData();
  const action = String(form.get("__action") ?? "");
  const res =
    action === "login"
      ? await handleLoginSubmit(db, req, form, deps)
      : action === "consent"
        ? await handleConsentSubmit(db, req, form, deps)
        : htmlError("Invalid request", "unknown form action", 400);
  return bridgeIfCrossOrigin(res, deps.issuer, db, String(form.get("client_id") ?? ""));
}

async function handleLoginSubmit(db: D1Database, req: Request, form: FormData, deps: OAuthDeps): Promise<Response> {
  const params = paramsFromForm(form);
  if ("error" in params) return htmlError("Invalid authorization request", params.error, 400);
  if (!verifyCsrfToken(req, form)) return htmlError("Invalid request", "CSRF token mismatch.", 403);
  const email = String(form.get("email") ?? "");
  const password = String(form.get("password") ?? "");
  const now = deps.now?.() ?? new Date();
  // Same brute-force fence as the console /login (this is the other public
  // login-submit path). Check lockout BEFORE the expensive password verify.
  const key = loginKey(clientIp(req), email);
  if ((await isLoginLocked(deps.rateLimiter, key, now)).locked) {
    return renderLoginPage(req, params, "Too many attempts. Please wait a few minutes and try again.");
  }
  const user = email ? await getUserByEmail(db, email) : null;
  // SUSPENDED accounts get the same wrong-password message here too (this is
  // the other public login-submit path) — never a session, never an oracle.
  if (!user || !(await verifyPassword(user, password)) || user.suspendedAt) {
    await recordLoginFailure(deps.rateLimiter, key, now);
    return renderLoginPage(req, params, "Incorrect email or password.");
  }
  await clearLoginFailures(deps.rateLimiter, key);
  // Transparent KDF upgrade: a verified-correct password stored under the
  // legacy sha256 verifier is re-hashed to the current format (users.ts, #28).
  if (needsRehash(user)) await setPassword(db, user.id, password);

  // 2FA gate: a password login here must NOT bypass an enrolled second factor.
  // Stash a pending login whose `next` resumes THIS authorize request (with the
  // session the /login/2fa handler mints), and send the user to the code prompt.
  if (await isTotpEnrolled(db, user.id)) {
    const token = await createPendingLogin(db, user.id, buildAuthorizeUrl(deps.issuer, params), now);
    return redirectResponse("/login/2fa", { "set-cookie": buildPendingLoginCookie(token) });
  }

  const session = await createSession(db, user.id, now);
  // Re-enter the flow WITH the session cookie; attach it to the response.
  const carrier = new Request(`${deps.issuer}/oauth/authorize`, {
    headers: { cookie: `${SESSION_COOKIE}=${session.id}` },
  });
  const res = await authorizeCore(db, carrier, params, deps);
  const headers = new Headers(res.headers);
  headers.append("set-cookie", buildSessionCookie(session.id));
  return new Response(res.body, { status: res.status, headers });
}

/**
 * Reconstruct the GET /oauth/authorize URL from parsed params — the resume
 * handle for flows that leave this page and come back with a session: the
 * post-2FA `next` (pending_logins), and the magic-link `next` (magic_links,
 * migration 0017 — auth-handlers.ts stores it server-side at send time).
 */
export function buildAuthorizeUrl(issuer: string, params: AuthorizeParams): string {
  const u = new URL(`${issuer}/oauth/authorize`);
  u.searchParams.set("client_id", params.clientId);
  u.searchParams.set("redirect_uri", params.redirectUri);
  u.searchParams.set("response_type", params.responseType);
  u.searchParams.set("scope", params.scope);
  u.searchParams.set("code_challenge", params.codeChallenge);
  u.searchParams.set("code_challenge_method", params.codeChallengeMethod);
  if (params.state !== null) u.searchParams.set("state", params.state);
  if (params.resource !== null) u.searchParams.set("resource", params.resource);
  if (params.vault !== null) u.searchParams.set("vault", params.vault);
  return u.toString();
}

async function handleConsentSubmit(db: D1Database, req: Request, form: FormData, deps: OAuthDeps): Promise<Response> {
  const params = paramsFromForm(form);
  if ("error" in params) return htmlError("Invalid authorization request", params.error, 400);
  if (!verifyCsrfToken(req, form)) return htmlError("Invalid request", "CSRF token mismatch.", 403);
  if (!isSameOriginRequest(req, resolveBoundOrigins(deps))) {
    return htmlError("Invalid request", "Cross-origin consent submission rejected.", 403);
  }
  const sessionId = parseSessionCookie(req.headers.get("cookie"));
  const session = sessionId ? await findActiveSession(db, sessionId, deps.now?.() ?? new Date()) : null;
  if (!session) return htmlError("Session expired", "Please sign in again.", 401);
  const client = await getClient(db, params.clientId);
  if (!client) return htmlError("Unknown application", "The client is not registered.", 400);
  try {
    requireRegisteredRedirectUri(client, params.redirectUri);
  } catch {
    return htmlError("Redirect mismatch", "The redirect_uri does not match any URI registered for this app.", 400);
  }

  if (String(form.get("decision") ?? "") !== "approve") {
    return oauthErrorRedirect(params.redirectUri, "access_denied", "user denied the request", params.state);
  }

  const boundVault = resolveResourceVault(params.resource, {
    boundOrigins: resolveBoundOrigins(deps),
    vaultBaseDomain: deps.vaultBaseDomain,
    vaultOrigin: deps.vaultOrigin,
  });
  if (boundVault) {
    params.scope = narrowResourceVaultScopes(params.scope.split(" ").filter((s) => s.length > 0), boundVault).join(" ");
  }

  let scopes = params.scope.split(" ").filter((s) => s.length > 0);
  const blocked = findNonRequestableScopes(scopes);
  if (blocked.length > 0) {
    return oauthErrorRedirect(
      params.redirectUri,
      "invalid_scope",
      `requested scopes are not available via the public authorization endpoint: ${blocked.join(", ")}`,
      params.state,
    );
  }

  // Narrow unnamed vault verbs to the picked vault (form pick or `vault=` hint).
  if (unnamedVaultVerbs(scopes).length > 0) {
    const picked = String(form.get("vault_pick") ?? "") || (params.vault ?? "");
    if (!picked || !VAULT_NAME_RE.test(picked)) {
      return htmlError("Vault required", "Choose a vault to authorize.", 400);
    }
    scopes = narrowVaultScopes(scopes, picked);
  }

  // Ownership gate — now that any pick is resolved, every named vault must be
  // owned before we record consent or issue a code.
  const ownershipDenied = await denyUnownedVaults(db, session.userId, scopes, params);
  if (ownershipDenied) return ownershipDenied;

  await recordGrant(db, session.userId, client.clientId, scopes, deps.now?.() ?? new Date());
  return issueAuthCodeRedirect(db, { ...params, scope: scopes.join(" ") }, scopes, session.userId, deps);
}
