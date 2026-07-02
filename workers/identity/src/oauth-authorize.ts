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
import { getUserByEmail, verifyPassword } from "./users.ts";
import { clearLoginFailures, clientIp, isLoginLocked, loginKey, recordLoginFailure } from "./rate-limit.ts";
import { ensureCsrfToken, verifyCsrfToken } from "./csrf.ts";
import { type AuthorizeParams, describeScopes, renderConsent, renderError, renderLogin } from "./ui.ts";
import {
  type OAuthDeps,
  findNonRequestableScopes,
  htmlResponse,
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
  return htmlResponse(
    renderConsent({
      params,
      csrfToken: csrf.token,
      clientName: client.clientName ?? client.clientId,
      scopeDescriptions: describeScopes(requestedScopes),
      lockedVault,
      needsVaultPick: hasUnnamedVault && !lockedVault,
    }),
    200,
    extra,
  );
}

function renderLoginPage(req: Request, params: AuthorizeParams, error?: string): Response {
  const csrf = ensureCsrfToken(req);
  const extra: Record<string, string> = csrf.setCookie ? { "set-cookie": csrf.setCookie } : {};
  return htmlResponse(renderLogin({ params, csrfToken: csrf.token, error }), error ? 200 : 200, extra);
}

export async function handleAuthorizeGet(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const parsed = paramsFromQuery(new URL(req.url));
  if ("error" in parsed) return htmlError("Invalid authorization request", parsed.error, 400);
  return authorizeCore(db, req, parsed, deps);
}

export async function handleAuthorizePost(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const form = await req.formData();
  const action = String(form.get("__action") ?? "");
  if (action === "login") return handleLoginSubmit(db, req, form, deps);
  if (action === "consent") return handleConsentSubmit(db, req, form, deps);
  return htmlError("Invalid request", "unknown form action", 400);
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
  if ((await isLoginLocked(db, key, now)).locked) {
    return renderLoginPage(req, params, "Too many attempts. Please wait a few minutes and try again.");
  }
  const user = email ? await getUserByEmail(db, email) : null;
  if (!user || !(await verifyPassword(user, password))) {
    await recordLoginFailure(db, key, now);
    return renderLoginPage(req, params, "Incorrect email or password.");
  }
  await clearLoginFailures(db, key);
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
