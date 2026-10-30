/**
 * /oauth/authorize — the auth-code entrypoint (GET) + the login/consent form
 * posts (POST). Reproduces the hub's flow, minus the multi-user vault-assignment
 * matrix (the cloud has no per-user vault ownership table; isolation is
 * structural). PKCE S256 is mandatory; a pending client auto-approves on a valid
 * session (single-consent); prior grants skip consent; resource/`vault=` bind the
 * consent + minted scopes to a named vault.
 */
import {
  composedVaultCreateScope,
  composedVaultScope,
  composedWildcardVaultsScope,
  parseAccountVaultsScope,
} from "@openparachute/door-contract";
import { issueGrantedAuthCode } from "./auth-codes.ts";
import {
  narrowResourceVaultScopes,
  narrowVaultScopes,
  resolveResourceVault,
  unnamedVaultVerbs,
  widenUnnamedVaultVerb,
} from "./audience.ts";
import { approveClient, getClient, requireRegisteredRedirectUri } from "./clients.ts";
import { GrantWriteConflictError, isCoveredByGrant, recordGrant } from "./grants.ts";
import { listVaultsForOwner, unownedNamedVaults, userOwnsVault } from "./vaults.ts";
import {
  SESSION_COOKIE,
  buildSessionCookie,
  createSessionIfProofHolds,
  findActiveSession,
  parseSessionCookie,
} from "./sessions.ts";
import { getUserByEmail, getUserById, needsRehash, rehashPasswordIfUnchanged, verifyPassword } from "./users.ts";
import { isTotpEnrolled } from "./two-factor.ts";
import { buildPendingLoginCookie, createPendingLogin } from "./pending-login.ts";
import { clearLoginFailures, clientIp, isLoginLocked, loginKey, recordLoginFailure } from "./rate-limit.ts";
import { ensureCsrfToken, verifyCsrfToken } from "./csrf.ts";
import { type AuthorizeParams, describeScopes, renderConsent, renderError, renderLogin, renderRedirectBridge } from "./ui.ts";
import {
  type OAuthDeps,
  consentIssuedByHost,
  findNonRequestableScopes,
  htmlResponse,
  isCrossOrigin,
  isSameOriginRequest,
  oauthErrorRedirect,
  redirectResponse,
  resolveBoundOrigins,
} from "./oauth-shared.ts";

const VAULT_NAME_RE = /^[a-zA-Z0-9_-]+$/;

function htmlError(title: string, message: string, status: number, action?: { href: string; label: string }): Response {
  return htmlResponse(renderError({ title, message, ...(action ? { action } : {}) }), status);
}

/**
 * The consent couldn't turn into a code because the grant changed meanwhile:
 * a Disconnect removed it before the code existed, another consent for the
 * same app replaced it, or the conditional write kept missing. The person
 * starts again from the app; nothing was issued.
 */
function grantChangedWhileApproving(): Response {
  return htmlError(
    "Connect again",
    "This app's access to your vaults changed while you were approving it (it may have been disconnected). Nothing was connected. Go back to the app and connect again.",
    409,
  );
}

/** Record the consent and issue its code, or the 409 page if the grant changed under us. */
async function recordGrantAndRedirect(
  db: D1Database,
  params: AuthorizeParams,
  scopes: string[],
  userId: string,
  clientId: string,
  deps: OAuthDeps,
): Promise<Response> {
  try {
    await recordGrant(db, userId, clientId, scopes, deps.now?.() ?? new Date());
  } catch (err) {
    if (err instanceof GrantWriteConflictError) return grantChangedWhileApproving();
    throw err;
  }
  return (
    (await issueAuthCodeRedirect(db, { ...params, scope: scopes.join(" ") }, scopes, userId, deps)) ??
    grantChangedWhileApproving()
  );
}

/**
 * The account-vaults request scopes in the set (Wave A). Called only AFTER the
 * wall gate ({@link findNonRequestableScopes}) has rejected every non-requestable
 * `account:*` scope, so the sole `account:` scopes that can survive to here are
 * the requestable account-vaults forms — the un-narrowed `account:vaults` and the
 * blanket `account:<id>:vaults`. The 4-part narrowed form is non-requestable and
 * never reaches this list. Shared by the authorize gate and the consent submit so
 * both agree on what an account-vaults request is.
 */
function accountVaultsRequestScopes(scopes: readonly string[]): string[] {
  return scopes.filter((s) => s.startsWith("account:"));
}

/**
 * Refuse an account-vaults request that (1) mixes with any non-account scope
 * (two audiences can't share one grant) or (2) names — in a 3-part
 * `account:<id>:vaults` — a DIFFERENT account than the signed-in owner (a
 * cross-account request; consent always re-keys to `session.userId`, but a
 * mismatched id is refused loudly rather than silently rewritten). Returns an
 * `invalid_scope` error redirect, or null to pass. Runs at BOTH the authorize
 * gate and the consent submit (defense-in-depth). `accountScopes` is the output
 * of {@link accountVaultsRequestScopes}, non-empty.
 */
function denyMixedOrForeignAccountVaults(
  accountScopes: readonly string[],
  allScopes: readonly string[],
  userId: string,
  params: AuthorizeParams,
): Response | null {
  if (allScopes.some((s) => !s.startsWith("account:"))) {
    return oauthErrorRedirect(params.redirectUri, "invalid_scope", "account:vaults cannot be combined with other scopes", params.state);
  }
  for (const s of accountScopes) {
    const parsed = parseAccountVaultsScope(s); // null for the 2-part un-narrowed form
    if (parsed && parsed.id !== userId) {
      return oauthErrorRedirect(params.redirectUri, "invalid_scope", "account:vaults names a different account", params.state);
    }
  }
  return null;
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

/**
 * The redirect carrying a fresh code, or null when the grant no longer holds
 * these scopes — a Disconnect committed after the caller read or wrote it
 * (see {@link issueGrantedAuthCode}). Every authorize path records or checks a
 * grant before it lands here, so null means "disconnected meanwhile".
 */
async function issueAuthCodeRedirect(
  db: D1Database,
  params: AuthorizeParams,
  scopes: string[],
  userId: string,
  deps: OAuthDeps,
): Promise<Response | null> {
  const code = await issueGrantedAuthCode(db, {
    clientId: params.clientId,
    userId,
    redirectUri: params.redirectUri,
    scopes,
    codeChallenge: params.codeChallenge,
    codeChallengeMethod: params.codeChallengeMethod,
    now: deps.now,
  });
  if (!code) return null;
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
    if (!session) return renderLoginPage(req, params, undefined, client.clientName);
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

  if (!session) return renderLoginPage(req, params, undefined, client.clientName);

  // Account-vaults (Wave A) — a wholly separate consent surface from the vault
  // picker. Refuse a mixed/foreign-id request, then ALWAYS render consent (never
  // skip-consent — the owner re-elects the vault set every time) with a checkbox
  // per owned vault. Returns before the vault-picker/verb-selector path below.
  const accountVaultsScopes = accountVaultsRequestScopes(requestedScopes);
  if (accountVaultsScopes.length > 0) {
    const refused = denyMixedOrForeignAccountVaults(accountVaultsScopes, requestedScopes, session.userId, params);
    if (refused) return refused;
    const csrf = ensureCsrfToken(req);
    const extra: Record<string, string> = csrf.setCookie ? { "set-cookie": csrf.setCookie } : {};
    const consentUser = await getUserById(db, session.userId);
    const ownedVaults = (await listVaultsForOwner(db, session.userId)).map((v) => v.name);
    return htmlResponse(
      renderConsent({
        params,
        csrfToken: csrf.token,
        clientName: client.clientName ?? client.clientId,
        scopeDescriptions: describeScopes(requestedScopes),
        lockedVault: null,
        needsVaultPick: false,
        ownedVaults: [],
        verbSelector: null,
        accountVaults: { ownedVaults },
        issuerHost: consentIssuedByHost(req, params.resource, deps),
        email: consentUser?.email ?? "",
        notYouNext: authorizeResumePath(params),
      }),
      200,
      extra,
    );
  }

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
    const redirect = await issueAuthCodeRedirect(db, params, requestedScopes, session.userId, deps);
    if (redirect) return redirect;
    // Disconnected between the grant read and the code insert: ask again.
  }

  const lockedVault = params.vault && VAULT_NAME_RE.test(params.vault) ? params.vault : null;
  const needsVaultPick = hasUnnamedVault && !lockedVault;
  const csrf = ensureCsrfToken(req);
  const extra: Record<string, string> = csrf.setCookie ? { "set-cookie": csrf.setCookie } : {};
  // The session is already proven live (findActiveSession JOINs users WHERE
  // suspended_at IS NULL AND deleted_at IS NULL), so the user row always
  // resolves here — `?? ""` is defensive only, matching the codebase's
  // convention elsewhere.
  const consentUser = await getUserById(db, session.userId);
  // Only the unnamed-verb pick branch needs the owner's vault list (the dropdown
  // that replaced the free-text input); every other branch skips the extra read.
  const ownedVaults = needsVaultPick ? (await listVaultsForOwner(db, session.userId)).map((v) => v.name) : [];
  // hub#689 port — the owner-elected read/write/admin selector. Offered only on
  // the unnamed-verb pick branch when the owner has at least one pickable
  // (owned) vault AND the client requested an upgradeable unnamed
  // `vault:read`/`vault:write` verb. Ownership === admin authority in the cloud,
  // so every pickable vault is one the owner holds admin on (the hub's render
  // precondition). An already-admin unnamed request (`vault:admin`) yields an
  // empty upgradeable set → no selector (it is already the top level).
  const upgradeableVerbs = unnamedVaultVerbs(requestedScopes).filter((v) => v === "read" || v === "write");
  const verbSelector = needsVaultPick && ownedVaults.length > 0 && upgradeableVerbs.length > 0 ? { requestedVerbs: upgradeableVerbs } : null;
  return htmlResponse(
    renderConsent({
      params,
      csrfToken: csrf.token,
      clientName: client.clientName ?? client.clientId,
      scopeDescriptions: describeScopes(requestedScopes),
      lockedVault,
      needsVaultPick,
      ownedVaults,
      verbSelector,
      accountVaults: null,
      // The "issued by <host>" trust line — the DOOR the user came through (the
      // bound request/resource origin, e.g. my.parachute.computer for a my./mcp
      // connect), else the issuer. Bound-gated in consentIssuedByHost, so never
      // an arbitrary host; DISPLAY ONLY — iss/aud/JWKS unchanged (#42 + the
      // my.-origin consent-face fix).
      issuerHost: consentIssuedByHost(req, params.resource, deps),
      // Auth redesign §3 move 1: "Signed in as {email} · Not you?" — the
      // ceremony now names the account approving the grant. `notYouNext`
      // reconstructs THIS exact pending authorize URL, so a "Not you?"
      // logout lands back here (no session → the login page, params intact)
      // and the connector request resumes without any new machinery.
      email: consentUser?.email ?? "",
      notYouNext: authorizeResumePath(params),
    }),
    200,
    extra,
  );
}

function renderLoginPage(req: Request, params: AuthorizeParams, error?: string, clientName?: string | null): Response {
  const csrf = ensureCsrfToken(req);
  const extra: Record<string, string> = csrf.setCookie ? { "set-cookie": csrf.setCookie } : {};
  // Errors on this page today only come from the password submit path, so an
  // error render opens the password disclosure (magic-send errors re-render via
  // auth-handlers.ts with showPassword: false).
  return htmlResponse(renderLogin({ params, csrfToken: csrf.token, error, showPassword: Boolean(error), clientName }), 200, extra);
}

/**
 * The origin where a person's sign-in session lives, when that is NOT the
 * issuer origin — `APP_ORIGIN` (my.parachute.computer in production), but only
 * when it is a DIFFERENT origin from the issuer AND a bound origin of this same
 * worker (so the consent POST from there passes the same-origin gate, and we
 * never send anyone to a host this worker doesn't serve — e.g. the legacy
 * Notes PWA default when APP_ORIGIN is unset). Null when the issuer IS the
 * home origin (staging: single-origin), so the authorize flow runs in place.
 */
export function authorizeHomeOrigin(deps: OAuthDeps): string | null {
  const home = deps.appOrigin.replace(/\/$/, "");
  if (home === deps.issuer) return null;
  return resolveBoundOrigins(deps).includes(home) ? home : null;
}

/**
 * ONE-PASS CONNECT (T-318). The OAuth issuer is `cloud.parachute.computer`
 * (every registered connector, the AS metadata, `iss`, JWKS — fixed forever),
 * but people sign in on `my.parachute.computer`. Both are Custom Domains of
 * THIS worker, yet the session cookie is host-only, so an authorize request
 * rendered on cloud. saw no session and asked for a SECOND email sign-in in the
 * middle of connecting Claude.
 *
 * So a browser GET of `/oauth/authorize` on the ISSUER host is sent (302, path +
 * query byte-identical) to the same path on the home origin, where the session
 * lives. Sign-in (only if truly signed out) and consent then run there; the
 * consent POST is same-origin on my. (a bound origin); the auth code lands in
 * the shared D1; the client's redirect carries the same `code` + `state`; and
 * the token exchange stays at `cloud./oauth/token`. Nothing a client can
 * observe about the issuer changes — only where the human pages render.
 *
 * Scope: GET only. A POST to cloud./oauth/authorize (a login/consent form that
 * was rendered on cloud. before this deploy) is still served in place — a 302
 * would turn it into a GET and drop the body. Requests on any other host (my.,
 * app., workers.dev) are served in place.
 *
 * `enabled` is the caller's production gate (index.ts): the cloud./my. split
 * exists only in production, while the handler-integration suite drives the
 * authorize pages on the ISSUER host under the committed production [vars]
 * with ENVIRONMENT="test" — the same gate `cloudFrontDoorRedirect` uses.
 * Staging is single-origin (APP_ORIGIN == ISSUER), so it is a no-op there
 * regardless.
 */
export function authorizeHomeRedirect(req: Request, deps: OAuthDeps, enabled: boolean): Response | null {
  if (!enabled) return null;
  const home = authorizeHomeOrigin(deps);
  if (!home) return null;
  const url = new URL(req.url);
  if (url.origin !== deps.issuer) return null;
  return redirectResponse(`${home}${url.pathname}${url.search}`, { "cache-control": "no-store" });
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
  // Keep naming the connecting app on an error re-render.
  const clientName = (await getClient(db, params.clientId))?.clientName ?? null;
  // Same brute-force fence as the console /login (this is the other public
  // login-submit path). Check lockout BEFORE the expensive password verify.
  const key = loginKey(clientIp(req), email);
  if ((await isLoginLocked(deps.rateLimiter, key, now)).locked) {
    return renderLoginPage(req, params, "Too many attempts. Please wait a few minutes and try again.", clientName);
  }
  const user = email ? await getUserByEmail(db, email) : null;
  // SUSPENDED or DELETED accounts get the same wrong-password message here
  // too (this is the other public login-submit path) — never a session,
  // never an oracle.
  if (!user || !(await verifyPassword(user, password)) || user.suspendedAt || user.deletedAt) {
    await recordLoginFailure(deps.rateLimiter, key, now);
    return renderLoginPage(req, params, "Incorrect email or password.", clientName);
  }
  await clearLoginFailures(deps.rateLimiter, key);
  // Transparent KDF upgrade: a verified-correct password stored under the
  // legacy sha256 verifier is re-hashed to the current format (users.ts, #28).
  // Conditional on the verifier just matched (see console.ts handleLoginPost).
  const passwordHash = needsRehash(user)
    ? await rehashPasswordIfUnchanged(db, user.id, user.passwordHash, password)
    : user.passwordHash;

  // 2FA gate: a password login here must NOT bypass an enrolled second factor.
  // Stash a pending login whose `next` resumes THIS authorize request (with the
  // session the /login/2fa handler mints), and send the user to the code prompt.
  if (await isTotpEnrolled(db, user.id)) {
    const token = await createPendingLogin(db, user.id, authorizeResumePath(params), now);
    return redirectResponse("/login/2fa", { "set-cookie": buildPendingLoginCookie(token) });
  }

  // Only if the row still holds the verifier just matched: a legacy-account
  // claim that landed during the check leaves this sign-in nothing.
  const session = await createSessionIfProofHolds(db, user.id, { passwordHash }, now);
  if (!session) return renderLoginPage(req, params, "Incorrect email or password.", clientName);
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
 * Reconstruct the pending GET /oauth/authorize request from parsed params, as
 * an ORIGIN-RELATIVE path (`/oauth/authorize?…`) — the resume handle for flows
 * that leave this page and come back with a session: the post-2FA `next`
 * (pending_logins), the magic-link / sign-in-code `next` (magic_links,
 * migration 0017 — auth-handlers.ts stores it server-side at send time), and
 * the consent page's "Not you?" logout `next`.
 *
 * Relative on purpose (T-318 one-pass connect): the authorize pages now render
 * on the home origin (my.) while the issuer is cloud. A resume target pinned
 * to the issuer would (a) land on a host where the just-minted session cookie
 * doesn't exist, and (b) turn every form POST that ends in it (/auth/code,
 * /login/2fa, /logout) into a cross-origin 302, which Chrome's
 * `form-action 'self'` silently blocks. Relative resumes on whichever origin
 * the person signed in on — the one where their session now lives.
 * `safeNext` accepts a relative path, so no new trust is introduced.
 */
export function authorizeResumePath(params: AuthorizeParams): string {
  const q = new URLSearchParams();
  q.set("client_id", params.clientId);
  q.set("redirect_uri", params.redirectUri);
  q.set("response_type", params.responseType);
  q.set("scope", params.scope);
  q.set("code_challenge", params.codeChallenge);
  q.set("code_challenge_method", params.codeChallengeMethod);
  if (params.state !== null) q.set("state", params.state);
  if (params.resource !== null) q.set("resource", params.resource);
  if (params.vault !== null) q.set("vault", params.vault);
  return `/oauth/authorize?${q.toString()}`;
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
  if (!session) {
    return htmlError(
      "Signed out",
      "You were signed out before allowing the connection. Sign in, then go back to your AI app and connect again.",
      401,
      { href: "/login", label: "Sign in" },
    );
  }
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

  // Account-vaults (MCP Phase 2 PR3) — the COMPOSED consent surface. The screen
  // is the SOLE author of the composed scopes (they are non-requestable); this
  // submit COMPOSES the grant from the form and EMITS the composed forms PR2
  // enforces. Every input is UNTRUSTED and RE-VALIDATED server-side, fail-closed:
  //   - the account id is ALWAYS `session.userId` — never a form value — so a
  //     forged/foreign id can never key a scope to another account;
  //   - the access verb is whitelisted to {read, write} ONLY — anything else,
  //     INCLUDING "admin" (the ceiling), is a 400 (belt-and-suspenders: the
  //     door-contract builders also throw on a bad slot, but we reject explicitly);
  //   - every named vault (specific mode) is re-checked against OWNERSHIP.
  // NEW consents emit composed forms; legacy grants + refresh rows keep their
  // frozen legacy semantics (PR2 handles both). recordGrant family-replaces the
  // whole vault family (legacy + composed) so a re-consent replaces, never widens.
  const accountVaultsScopes = accountVaultsRequestScopes(scopes);
  if (accountVaultsScopes.length > 0) {
    const refused = denyMixedOrForeignAccountVaults(accountVaultsScopes, scopes, session.userId, params);
    if (refused) return refused;

    // Access level — fail-closed verb whitelist. NEVER admin, never anything else.
    const verb = String(form.get("access_verb") ?? "");
    if (verb !== "read" && verb !== "write") {
      return htmlError("Invalid request", "Choose a valid access level (read or read & write).", 400);
    }

    const owned = (await listVaultsForOwner(db, session.userId)).map((v) => v.name);
    const ownedSet = new Set(owned);
    const composedScopes: string[] = [];

    // Vault set — the MODE radio decides, not the box count. "specific" with every
    // box checked emits the fixed 5-part set, NOT the wildcard.
    const mode = String(form.get("vault_mode") ?? "");
    if (mode === "specific") {
      const included = [
        ...new Set(form.getAll("vault_include").filter((v): v is string => typeof v === "string")),
      ];
      if (included.length === 0) {
        return htmlError("Vault required", "Select at least one vault, or choose “Any vault.”", 400);
      }
      const unowned = included.filter((v) => !ownedSet.has(v));
      if (unowned.length > 0) {
        return oauthErrorRedirect(
          params.redirectUri,
          "invalid_scope",
          `you do not own ${unowned.length > 1 ? "these vaults" : "the vault"}: ${unowned.join(", ")}`,
          params.state,
        );
      }
      for (const v of included) composedScopes.push(composedVaultScope(session.userId, v, verb));
    } else if (mode === "wildcard") {
      composedScopes.push(composedWildcardVaultsScope(session.userId, verb));
    } else {
      return htmlError("Invalid request", "Choose which vaults to include.", 400);
    }

    // Create new vaults — a checkbox CHECKED by default; present ⇒ grant it.
    if (form.get("vault_create") !== null) {
      composedScopes.push(composedVaultCreateScope(session.userId));
    }

    return recordGrantAndRedirect(db, params, composedScopes, session.userId, client.clientId, deps);
  }

  // Narrow unnamed vault verbs to the picked vault (form pick or `vault=` hint).
  if (unnamedVaultVerbs(scopes).length > 0) {
    const picked = String(form.get("vault_pick") ?? "") || (params.vault ?? "");
    if (!picked || !VAULT_NAME_RE.test(picked)) {
      return htmlError(
        "Make a vault first",
        "A connection needs a vault to read and write. Make one, then go back to your AI app and connect again.",
        400,
        { href: "/console", label: "Make your first vault" },
      );
    }
    // hub#689 port — owner-elected verb widening. `verb_select` is an UNTRUSTED
    // hint from the consent radio; re-level the unnamed read/write verb(s) to the
    // elected level ONLY after re-deriving, server-side, that this user OWNS the
    // picked vault (ownership === admin authority in the cloud). The ownership
    // gate below (`denyUnownedVaults`) and the token-mint re-check remain the
    // backstops, so a forged `verb_select=admin` on an unowned vault is refused
    // regardless. Absent/invalid `verb_select` ⇒ scopes untouched (byte-identical
    // to the pre-selector behavior).
    const electedVerb = String(form.get("verb_select") ?? "").trim();
    if (
      (electedVerb === "read" || electedVerb === "write" || electedVerb === "admin") &&
      (await userOwnsVault(db, session.userId, picked))
    ) {
      scopes = widenUnnamedVaultVerb(scopes, electedVerb);
    }
    scopes = narrowVaultScopes(scopes, picked);
  }

  // Ownership gate — now that any pick is resolved, every named vault must be
  // owned before we record consent or issue a code.
  const ownershipDenied = await denyUnownedVaults(db, session.userId, scopes, params);
  if (ownershipDenied) return ownershipDenied;

  return recordGrantAndRedirect(db, params, scopes, session.userId, client.clientId, deps);
}
