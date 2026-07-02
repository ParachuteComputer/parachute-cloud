/**
 * POST /oauth/token — `authorization_code` + `refresh_token` grants only.
 * Direct port of the hub's token endpoint: same error discriminators, same
 * success shape `{access_token, token_type:"Bearer", expires_in:900,
 * refresh_token, scope, services}`, and the same refresh-rotation semantics
 * (one-generation 30s grace, replay → family revocation).
 *
 * DIVERGENCE (documented): `vault_scope` is always `[]` (the "unrestricted"
 * sentinel the hub uses for admins). The cloud has no per-user vault-assignment
 * matrix — isolation is structural (one DO per vault), not claim-narrowed within
 * one issuer — so the claim is emitted for wire-shape parity but carries no
 * per-user pin. `aud` + `scope` remain the real gates.
 */
import {
  AuthCodeExpiredError,
  AuthCodeNotFoundError,
  AuthCodePkceMismatchError,
  AuthCodeRedirectMismatchError,
  AuthCodeUsedError,
  redeemAuthCode,
} from "./auth-codes.ts";
import { inferAudience } from "./audience.ts";
import { type OAuthClient, getClient, verifyClientSecret } from "./clients.ts";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_GRACE_MS,
  type RefreshTokenRow,
  findRefreshToken,
  liveFamilyRefreshRows,
  prepareRefreshToken,
  signAccessToken,
  signRefreshToken,
} from "./tokens.ts";
import { type OAuthDeps, buildServicesCatalog, jsonResponse } from "./oauth-shared.ts";

function extractClientCredentials(
  req: Request,
  form: FormData,
): { headerClientId: string | null; clientSecret: string | null } {
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Basic ")) {
    try {
      const decoded = atob(auth.slice("Basic ".length));
      const idx = decoded.indexOf(":");
      if (idx >= 0) return { headerClientId: decoded.slice(0, idx), clientSecret: decoded.slice(idx + 1) };
    } catch {
      // fall through to form
    }
  }
  const secret = form.get("client_secret");
  return { headerClientId: null, clientSecret: typeof secret === "string" && secret ? secret : null };
}

function clientAuthFailure(description: string): Response {
  return jsonResponse({ error: "invalid_client", error_description: description }, 401);
}

async function authenticateClient(
  client: OAuthClient,
  req: Request,
  form: FormData,
  bodyClientId: string,
): Promise<Response | null> {
  if (!client.clientSecretHash) return null; // public client: PKCE binds it
  const { headerClientId, clientSecret } = extractClientCredentials(req, form);
  if (!clientSecret) return clientAuthFailure("client_secret required for confidential client");
  if (headerClientId !== null && headerClientId !== bodyClientId) {
    return clientAuthFailure("authorization header client_id does not match request body");
  }
  if (!(await verifyClientSecret(client, clientSecret))) return clientAuthFailure("client_secret mismatch");
  return null;
}

export function pendingClientJson(clientId: string, issuer: string): Response {
  const base = issuer.replace(/\/$/, "");
  return jsonResponse(
    {
      error: "invalid_client",
      error_description: "client is registered but has not been approved by the hub operator (#74)",
      approve_url: `${base}/admin/approve-client/${encodeURIComponent(clientId)}`,
    },
    401,
  );
}

function mapAuthCodeError(err: unknown): Response {
  if (err instanceof AuthCodeNotFoundError) {
    return jsonResponse({ error: "invalid_grant", error_description: "code not found" }, 400);
  }
  if (err instanceof AuthCodeExpiredError) {
    return jsonResponse({ error: "invalid_grant", error_description: "code expired" }, 400);
  }
  if (err instanceof AuthCodeUsedError) {
    return jsonResponse({ error: "invalid_grant", error_description: "code already redeemed" }, 400);
  }
  if (err instanceof AuthCodePkceMismatchError) {
    return jsonResponse({ error: "invalid_grant", error_description: "code_verifier mismatch" }, 400);
  }
  if (err instanceof AuthCodeRedirectMismatchError) {
    return jsonResponse({ error: "invalid_grant", error_description: "redirect_uri mismatch" }, 400);
  }
  const msg = err instanceof Error ? err.message : String(err);
  return jsonResponse({ error: "server_error", error_description: msg }, 500);
}

export async function handleToken(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const form = await req.formData();
  const grantType = String(form.get("grant_type") ?? "");
  if (grantType === "authorization_code") return handleTokenAuthorizationCode(db, req, form, deps);
  if (grantType === "refresh_token") return handleTokenRefresh(db, req, form, deps);
  return jsonResponse(
    { error: "unsupported_grant_type", error_description: `grant_type "${grantType}" is not supported` },
    400,
  );
}

async function handleTokenAuthorizationCode(
  db: D1Database,
  req: Request,
  form: FormData,
  deps: OAuthDeps,
): Promise<Response> {
  const code = String(form.get("code") ?? "");
  const clientId = String(form.get("client_id") ?? "");
  const redirectUri = String(form.get("redirect_uri") ?? "");
  const codeVerifier = String(form.get("code_verifier") ?? "");
  if (!code || !clientId || !redirectUri || !codeVerifier) {
    return jsonResponse({ error: "invalid_request", error_description: "missing required parameter" }, 400);
  }
  const client = await getClient(db, clientId);
  if (!client) return jsonResponse({ error: "invalid_client", error_description: "unknown client_id" }, 401);
  if (client.status !== "approved") return pendingClientJson(client.clientId, deps.issuer);
  const authFailure = await authenticateClient(client, req, form, clientId);
  if (authFailure) return authFailure;
  let redeemed: Awaited<ReturnType<typeof redeemAuthCode>>;
  try {
    redeemed = await redeemAuthCode(db, { code, clientId, redirectUri, codeVerifier, now: deps.now });
  } catch (err) {
    return mapAuthCodeError(err);
  }
  const audience = inferAudience(redeemed.scopes);
  const access = await signAccessToken(db, {
    sub: redeemed.userId,
    scopes: redeemed.scopes,
    audience,
    clientId: redeemed.clientId,
    issuer: deps.issuer,
    vaultScope: [],
    now: deps.now,
  });
  // Access + refresh share `jti` (revocation acts on the shared jti/family).
  const refresh = await signRefreshToken(db, {
    jti: access.jti,
    userId: redeemed.userId,
    clientId: redeemed.clientId,
    scopes: redeemed.scopes,
    now: deps.now,
  });
  return jsonResponse({
    access_token: access.token,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refresh.token,
    scope: redeemed.scopes.join(" "),
    services: buildServicesCatalog(redeemed.scopes, deps),
  });
}

async function handleTokenRefresh(
  db: D1Database,
  req: Request,
  form: FormData,
  deps: OAuthDeps,
): Promise<Response> {
  const refreshToken = String(form.get("refresh_token") ?? "");
  const clientId = String(form.get("client_id") ?? "");
  if (!refreshToken || !clientId) {
    return jsonResponse({ error: "invalid_request", error_description: "missing required parameter" }, 400);
  }
  const client = await getClient(db, clientId);
  if (!client) return jsonResponse({ error: "invalid_client", error_description: "unknown client_id" }, 401);
  if (client.status !== "approved") return pendingClientJson(client.clientId, deps.issuer);
  const authFailure = await authenticateClient(client, req, form, clientId);
  if (authFailure) return authFailure;
  const row = await findRefreshToken(db, refreshToken);
  if (!row) return jsonResponse({ error: "invalid_grant", error_description: "refresh_token not found" }, 400);
  if (row.clientId !== clientId) {
    return jsonResponse({ error: "invalid_grant", error_description: "client_id mismatch" }, 400);
  }
  if (!row.userId) {
    return jsonResponse(
      { error: "invalid_grant", error_description: "refresh_token has no associated user" },
      400,
    );
  }
  const now = deps.now?.() ?? new Date();
  if (row.revokedAt) {
    // Replay of an already-rotated token. One-generation grace (hub#685):
    //   (a) WINDOW — revoked within the last REFRESH_GRACE_MS, and
    //   (b) IMMEDIATE-PREDECESSOR — this row's `rotated_to` IS the family's
    //       single live tip.
    // Both hold → benign concurrent/retried refresh: rotate the tip, no family
    // revocation. Anything else → theft: revoke the whole family.
    const live = await liveFamilyRefreshRows(db, row.familyId, now);
    const revokedAtMs = new Date(row.revokedAt).getTime();
    const withinWindow = now.getTime() - revokedAtMs <= REFRESH_GRACE_MS && now.getTime() >= revokedAtMs;
    const tip = live.length === 1 ? live[0]! : null;
    const isImmediatePredecessor = tip !== null && row.rotatedTo !== null && row.rotatedTo === tip.jti;
    if (withinWindow && isImmediatePredecessor && tip) {
      return rotateAndRespond(db, tip, deps, now);
    }
    await revokeFamilyOf(db, row.familyId, now);
    return jsonResponse({ error: "invalid_grant", error_description: "refresh_token revoked" }, 400);
  }
  if (now.getTime() > new Date(row.expiresAt).getTime()) {
    return jsonResponse({ error: "invalid_grant", error_description: "refresh_token expired" }, 400);
  }
  return rotateAndRespond(db, row, deps, now);
}

async function revokeFamilyOf(db: D1Database, familyId: string, now: Date): Promise<void> {
  await db
    .prepare("UPDATE tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL")
    .bind(now.toISOString(), familyId)
    .run();
}

/**
 * Rotate a single live refresh row: mint a new access+refresh pair bound to the
 * same family, then atomically (D1 batch) revoke the old row, insert the new
 * refresh row, and link old→new (`rotated_to`). The JWT is signed BEFORE the
 * batch (signing is async; the batch is the atomic unit).
 */
async function rotateAndRespond(
  db: D1Database,
  row: RefreshTokenRow,
  deps: OAuthDeps,
  now: Date,
): Promise<Response> {
  const refreshUserId = row.userId ?? "";
  const audience = inferAudience(row.scopes);
  const access = await signAccessToken(db, {
    sub: refreshUserId,
    scopes: row.scopes,
    audience,
    clientId: row.clientId,
    issuer: deps.issuer,
    vaultScope: [],
    now: deps.now,
  });
  const prepared = await prepareRefreshToken(db, {
    jti: access.jti,
    userId: refreshUserId,
    clientId: row.clientId,
    scopes: row.scopes,
    familyId: row.familyId,
    now: deps.now,
  });
  try {
    await db.batch([
      db.prepare("UPDATE tokens SET revoked_at = ? WHERE jti = ?").bind(now.toISOString(), row.jti),
      prepared.stmt,
      db.prepare("UPDATE tokens SET rotated_to = ? WHERE jti = ?").bind(access.jti, row.jti),
    ]);
  } catch (err) {
    // Concurrent rotation collided on the jti PK (or any INSERT-time error).
    // Clean invalid_grant per RFC 6749 §5.2 — the batch rolled back.
    return jsonResponse({ error: "invalid_grant", error_description: "refresh_token rotation conflict" }, 400);
  }
  return jsonResponse({
    access_token: access.token,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: prepared.token,
    scope: row.scopes.join(" "),
    services: buildServicesCatalog(row.scopes, deps),
  });
}
