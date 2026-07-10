/**
 * Conformance-corpus helpers: deps, PKCE, request builders, and the
 * mint/rotate/inspect primitives the token + rotation tests share. Everything
 * runs against the real D1 (`env.DB`) inside workerd.
 */
import { env } from "cloudflare:test";
import { randomBase64url, sha256Base64url, sha256Hex } from "../src/crypto.ts";
import { registerClient } from "../src/clients.ts";
import { issueAuthCode } from "../src/auth-codes.ts";
import { createUser } from "../src/users.ts";
import { namedVaultsInScopes } from "../src/vaults.ts";
import { SESSION_COOKIE, createSession } from "../src/sessions.ts";
import { handleToken } from "../src/oauth-token.ts";
import type { OAuthDeps } from "../src/oauth-shared.ts";

export const ISSUER = env.ISSUER;
export const VAULT_BASE = env.VAULT_BASE_DOMAIN;
export const REDIRECT_URI = "https://app.example/cb";
export const CSRF = "test-csrf-token";

export function db(): D1Database {
  return env.DB;
}

export function deps(now?: () => Date): OAuthDeps {
  return {
    issuer: ISSUER,
    vaultBaseDomain: VAULT_BASE,
    // APP_ORIGIN unset in the test env ⇒ the graceful default (the legacy Notes
    // PWA), mirroring resolveAppOrigin. The APP_ORIGIN-set path is exercised by
    // passing a widened env to app.fetch (see the deep-link tests).
    appOrigin: "https://notes.parachute.computer",
    boundOrigins: () => [ISSUER],
    now,
    rateLimiter: env.RATE_LIMITER,
  };
}

export async function makePkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomBase64url(32);
  const challenge = await sha256Base64url(verifier);
  return { verifier, challenge };
}

export function form(fields: Record<string, string>): URLSearchParams {
  return new URLSearchParams(fields);
}

export function tokenReq(fields: Record<string, string>): Request {
  return new Request(`${ISSUER}/oauth/token`, {
    method: "POST",
    body: form(fields),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
}

export function revokeReq(fields: Record<string, string>): Request {
  return new Request(`${ISSUER}/oauth/revoke`, {
    method: "POST",
    body: form(fields),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
}

/** GET /oauth/authorize with query params + an optional session cookie. */
export function authorizeGetReq(query: Record<string, string>, sessionId?: string): Request {
  const url = new URL(`${ISSUER}/oauth/authorize`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const headers: Record<string, string> = {};
  if (sessionId) headers.cookie = `${SESSION_COOKIE}=${sessionId}`;
  return new Request(url.toString(), { headers });
}

/** POST /oauth/authorize consent (approve/deny), same-origin + CSRF + session. */
export function consentReq(
  fields: Record<string, string>,
  opts: { sessionId: string; decision?: string },
): Request {
  const body = form({
    __action: "consent",
    __csrf: CSRF,
    decision: opts.decision ?? "approve",
    ...fields,
  });
  return new Request(`${ISSUER}/oauth/authorize`, {
    method: "POST",
    body,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: ISSUER,
      cookie: `${SESSION_COOKIE}=${opts.sessionId}; parachute_id_csrf=${CSRF}`,
    },
  });
}

/** POST /oauth/authorize login submit. */
export function loginReq(fields: Record<string, string>, opts: { email: string; password: string } ): Request {
  const body = form({ __action: "login", __csrf: CSRF, email: opts.email, password: opts.password, ...fields });
  return new Request(`${ISSUER}/oauth/authorize`, {
    method: "POST",
    body,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: ISSUER,
      cookie: `parachute_id_csrf=${CSRF}`,
    },
  });
}

export function registerReq(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ISSUER}/oauth/register`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
}

export async function seedUser(email = "owner@example.com", password = "correct horse"): Promise<{ id: string }> {
  const user = await createUser(env.DB, email, password);
  return { id: user.id };
}

/**
 * Grant `ownerUserId` ownership of vault `name` directly (bypassing the
 * slug/reserved validation in createVault — tests exercise arbitrary names).
 * Idempotent. Ownership is now a precondition for minting a `vault:<name>:*`
 * token, so the mint helpers + authorize tests seed it for the user.
 */
export async function seedVault(name: string, ownerUserId: string): Promise<void> {
  await env.DB.prepare("INSERT OR IGNORE INTO vaults (name, owner_user_id, created_at) VALUES (?, ?, ?)")
    .bind(name.toLowerCase(), ownerUserId, new Date().toISOString())
    .run();
}

export async function seedApprovedClient(
  opts: { redirectUris?: string[]; confidential?: boolean; clientName?: string } = {},
): Promise<{ clientId: string; clientSecret: string | null }> {
  const reg = await registerClient(env.DB, {
    redirectUris: opts.redirectUris ?? [REDIRECT_URI],
    status: "approved",
    confidential: opts.confidential,
    clientName: opts.clientName,
  });
  return { clientId: reg.client.clientId, clientSecret: reg.clientSecret };
}

export async function seedSession(userId: string): Promise<string> {
  const s = await createSession(env.DB, userId);
  return s.id;
}

export interface TokenPair {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
  services: Record<string, { url: string; version: string }>;
  /** app-client TokenResponse extension: present when scopes name exactly one vault. */
  vault?: string;
}

/**
 * Mint the initial access+refresh pair by issuing a code directly (bypassing the
 * consent UI) and redeeming it at /oauth/token — the token-endpoint conformance
 * path. `now` threads the deterministic clock through issuance + redemption.
 */
export async function mintInitialPair(
  clientId: string,
  userId: string,
  opts: { scope?: string; extra?: Record<string, string>; now?: () => Date } = {},
): Promise<TokenPair> {
  const scope = opts.scope ?? "vault:default:read";
  // Minting now requires the subject to own each named vault in the scope; a
  // legitimate mint implies ownership, so seed it for the user.
  for (const vname of namedVaultsInScopes(scope.split(" "))) await seedVault(vname, userId);
  const { verifier, challenge } = await makePkce();
  const code = await issueAuthCode(env.DB, {
    clientId,
    userId,
    redirectUri: REDIRECT_URI,
    scopes: scope.split(" "),
    codeChallenge: challenge,
    codeChallengeMethod: "S256",
    now: opts.now,
  });
  const res = await handleToken(
    env.DB,
    tokenReq({
      grant_type: "authorization_code",
      code: code.code,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
      ...(opts.extra ?? {}),
    }),
    deps(opts.now),
  );
  if (res.status !== 200) throw new Error(`mintInitialPair: token endpoint returned ${res.status}`);
  return (await res.json()) as TokenPair;
}

export async function refreshAt(clientId: string, refreshToken: string, at: Date): Promise<Response> {
  return handleToken(
    env.DB,
    tokenReq({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId }),
    deps(() => at),
  );
}

export async function familyIdFor(refreshPlaintext: string): Promise<string> {
  const hash = await sha256Hex(refreshPlaintext);
  const row = await env.DB.prepare("SELECT family_id FROM tokens WHERE refresh_token_hash = ?")
    .bind(hash)
    .first<{ family_id: string }>();
  if (!row) throw new Error("no token row for refresh plaintext");
  return row.family_id;
}

export async function liveRefreshCount(familyId: string): Promise<number> {
  const r = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM tokens WHERE family_id = ? AND revoked_at IS NULL AND refresh_token_hash IS NOT NULL",
  )
    .bind(familyId)
    .first<{ n: number }>();
  return r?.n ?? -1;
}

/** Decode a JWT payload without verifying (claims inspection in assertions). */
export function decodeJwtPayload(token: string): Record<string, unknown> {
  const part = token.split(".")[1] ?? "";
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(b64)) as Record<string, unknown>;
}
