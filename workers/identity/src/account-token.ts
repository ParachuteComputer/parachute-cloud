/**
 * `POST /account/token` — exchange the `parachute_id_session` cookie for a
 * short-lived JWT carrying the ACCOUNT credential `account:<owner-id>:admin`,
 * with `aud="account"`. This is the HOSTED door's half of the Parachute App
 * campaign's `/account/*` contract (Phase 2, C2) — the twin of the self-host
 * hub's `POST /account/token` (H1), minted from that door's own session cookie.
 *
 * The token this endpoint mints is the credential the `/account/*` REST surface
 * (C3) is Bearer-gated by; C1's `validateAccountToken` (account-auth.ts) is the
 * validator on the far side. Round-trip: mint here → validate there →
 * `hasAccountScope(scopes, ownerId, "admin")`.
 *
 * DIFFERENCE FROM THE HUB TWIN (SCOPE-b, deliberate). The hub mints a SUPERSET
 * (`account:self:admin` + the host scopes) because a single-operator box's
 * account bearer must also drive the existing host-scoped admin endpoints. The
 * cloud door has no such endpoints to re-drive — every account verb is served by
 * the net-new `/account/*` surface — so it mints ONLY the account scope, keyed
 * on the SESSION USER (`account:<session.userId>:admin`), not a `self` sentinel.
 * The cloud account is the tenant, not the box.
 *
 * Why `aud="account"` (SCOPE-a). Minted with an explicit `aud="account"` (not
 * `inferAudience`'s fallback) so the `/account/*` validator pins the audience and
 * a vault RS's strict `aud=vault.<name>` check refuses it outright — an account
 * token can never be spent as a vault token, belt-and-suspenders in both
 * directions (see account-auth.ts and audience.ts).
 *
 * Authorization — the console write boundary, gates IN ORDER (each fails closed
 * with its own status so the refusal reason is legible):
 *   1. **Session.** A live `parachute_id_session` cookie. `sessionUser` resolves
 *      it through `findActiveSession`, which JOINs `users` on `suspended_at IS
 *      NULL AND deleted_at IS NULL` — so a SUSPENDED (admin.ts suspend lever)
 *      or DELETED (migration 0023) owner's session is refused here, and no
 *      account token is minted. No session / suspended / deleted → 401.
 *   2. **CSRF.** A POST that performs a privileged mint, so it carries the
 *      double-submit token (`__csrf` in the JSON body — the SDK posts JSON, not a
 *      form; same `csrfTokenValid` core as the console's form POSTs).
 *      Missing/mismatched → 403.
 *   3. **Same-origin.** The request Origin (or Referer) must be one of the
 *      issuer's bound origins (resolveBoundOrigins, P0.5's set — the app origin
 *      during the two-issuer window). A missing/foreign origin → 403.
 *
 * Statelessness + revocation (SCOPE-d). The account token is deliberately NOT
 * persisted in the `tokens` table — no registry row, no per-jti revocation. It
 * is short-lived (10 min) and re-minted from the live session cookie; revocation
 * is by logout (kills the cookie → no re-mint, sessions.ts deleteSession) plus
 * the read-time suspend chokepoint above. A legacy-account claim (the owner
 * proving an address someone else signed up with) can't reach it either, so
 * the token carries `email_verified` as minted and `/account/*` refuses one
 * minted unverified once the account is verified (account-api.ts). A stateless mint avoids a DB write on
 * every re-mint, matching the internal `parachute-console` mints (vault-call.ts).
 */
import { csrfTokenValid, CSRF_FIELD } from "./csrf.ts";
import { ACCOUNT_TOKEN_AUDIENCE } from "./account-auth.ts";
import { isSameOriginRequest, jsonResponse, resolveBoundOrigins, type OAuthDeps } from "./oauth-shared.ts";
import { sessionUser } from "./session-user.ts";
import { parseSessionCookie } from "./sessions.ts";
import { signAccessToken } from "./tokens.ts";
import { NostrAuthError, authenticateNostrRequest, isNostrAuthorization } from "./nostr-auth.ts";
import type { User } from "./users.ts";
import { checkAndBumpNostrSignin, clientIp } from "./rate-limit.ts";

/** Short TTL — a page-snapshot threat can't carry the token for long. Matches
 * the hub twin's 10-min window; the app re-mints when it's about to lapse. */
export const ACCOUNT_TOKEN_TTL_SECONDS = 10 * 60;
/**
 * The client id stamped on the account token — the cloud account surface's own
 * platform-issuer identity, DISTINCT from the `parachute-console` id the
 * vault-worker internal seam is gated on (vault-call.ts FIRST_PARTY_CLIENT_ID).
 * Kept distinct on purpose (C2 review, matches the hub twin): a legible identity
 * in logs, and — since the account surface's tenant-facing VAULT tokens (C3
 * account-api.ts) share this id — a guarantee those tokens can never satisfy the
 * first-party internal-config gate even when they carry `vault:<name>:admin`.
 * Unforgeable because DCR client ids are server-generated UUIDs (clients.ts).
 */
export const ACCOUNT_TOKEN_CLIENT_ID = "parachute-account";

/** The account scope for a given owner: `account:<owner-id>:admin`. */
export function accountAdminScope(ownerId: string): string {
  return `account:${ownerId}:admin`;
}

/**
 * `POST /account/token` signed with NIP-98 (T-414; the box's twin is parachute-core account-token.ts): the account's
 * owner proves possession of a linked Nostr key and gets the same account token the session path mints, with no
 * cookie and no password. One npub can own every hub this way (box, cloud, your own Cloudflare), each hub its own
 * issuer. `nostr-auth.ts` does the checks (signature, kind, ±60 s, u, method, payload, single-use id) and the
 * account lookup (a linked key, or the single-owner OWNER_PUBKEY bootstrap on an empty instance).
 *
 * No CSRF or Origin gate: an Authorization header is not ambient, so no cross-site page can make a browser send
 * one. The same account chokepoints as the session path: a suspended or deleted account is refused.
 */
async function handleNostrAccountToken(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const fence = await checkAndBumpNostrSignin(deps.rateLimiter, clientIp(req), deps.now?.() ?? new Date());
  if (!fence.allowed) {
    return jsonResponse({ error: "rate_limited", error_description: "too many sign-in attempts; try again later" }, 429, {
      "cache-control": "no-store",
      "retry-after": String(fence.retryAfterSeconds),
    });
  }
  let user: User;
  let pubkey: string;
  try {
    ({ user, pubkey } = await authenticateNostrRequest(db, req, {
      ...(deps.ownerPubkey ? { ownerPubkey: deps.ownerPubkey } : {}),
      ...(deps.adminPubkeys?.length ? { adminPubkeys: deps.adminPubkeys } : {}),
      ...(deps.ownerPlan ? { ownerPlan: deps.ownerPlan } : {}),
      now: deps.now?.() ?? new Date(),
    }));
  } catch (err) {
    if (err instanceof NostrAuthError) return jsonError(401, "invalid_nostr_auth", `${err.code}: ${err.message}`);
    throw err;
  }
  if (user.deletedAt !== null || user.suspendedAt !== null) {
    return jsonError(401, "unauthenticated", "this account can't sign in");
  }
  const scopes = [accountAdminScope(user.id)];
  // An ADMIN_PUBKEYS key's token says so: /account/pubkeys refuses it, so an admin can't add or remove the account's
  // own sign-in keys (it can't stay on after it is dropped from the list, nor lock the owner out).
  const viaAdmin = !!deps.adminPubkeys?.includes(pubkey) && pubkey !== deps.ownerPubkey;
  const minted = await signAccessToken(db, {
    sub: user.id,
    scopes,
    audience: ACCOUNT_TOKEN_AUDIENCE,
    clientId: ACCOUNT_TOKEN_CLIENT_ID,
    issuer: deps.issuer,
    vaultScope: [],
    ttlSeconds: ACCOUNT_TOKEN_TTL_SECONDS,
    now: deps.now,
    emailVerified: user.emailVerified,
    ...(viaAdmin ? { permissions: { admin_pubkey: pubkey } } : {}),
  });
  return jsonResponse(
    { token: minted.token, expires_at: minted.expiresAt, scopes, aud: ACCOUNT_TOKEN_AUDIENCE },
    200,
    { "cache-control": "no-store" },
  );
}

/**
 * Pull the double-submit CSRF token from the JSON request body's `__csrf` field.
 * Tolerant of an absent/malformed body (returns null → the verify fails closed
 * with a 403), mirroring the hub twin's `readCsrfToken`.
 */
async function readCsrfToken(req: Request): Promise<string | null> {
  try {
    const body = (await req.json()) as unknown;
    if (body && typeof body === "object") {
      const token = (body as Record<string, unknown>)[CSRF_FIELD];
      return typeof token === "string" ? token : null;
    }
  } catch {
    // Empty or non-JSON body — no token.
  }
  return null;
}

function jsonError(status: number, error: string, description: string): Response {
  return jsonResponse({ error, error_description: description }, status, { "cache-control": "no-store" });
}

export async function handleAccountToken(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  // The owner's key door (T-414): `Authorization: Nostr <event>` instead of a session.
  if (isNostrAuthorization(req)) return handleNostrAccountToken(db, req, deps);

  // Gate 1 — session. `sessionUser` refuses a missing cookie AND a suspended
  // or deleted owner (findActiveSession's suspended_at/deleted_at JOIN) —
  // the mint chokepoint.
  const user = await sessionUser(db, req, deps);
  if (!user) {
    return jsonError(401, "unauthenticated", "no active session — sign in first");
  }

  // Gate 2 — CSRF double-submit. A cross-site forged POST must be refused before
  // any privileged mint. The token rides the JSON body's `__csrf` field.
  const csrf = await readCsrfToken(req);
  if (!csrfTokenValid(req, csrf)) {
    return jsonError(403, "csrf_failed", "missing or invalid CSRF token");
  }

  // Gate 3 — same-origin. The request Origin/Referer must be a bound origin
  // (resolveBoundOrigins). A foreign or opaque origin is refused.
  if (!isSameOriginRequest(req, resolveBoundOrigins(deps))) {
    return jsonError(403, "foreign_origin", "request origin is not allowed");
  }

  // The `email_verified` stamp, read in ONE statement with the session. Read
  // apart (sessionUser's two queries), a legacy-account claim landing between
  // them would hand a pre-claim session a token stamped verified, which the
  // /account/* gate accepts. Joined: either the claim already deleted the
  // session (no row → 401) or the flag predates the claim (stamped false →
  // refused once the account is verified).
  const verified = await db
    .prepare("SELECT u.email_verified AS v FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND u.id = ?")
    .bind(parseSessionCookie(req.headers.get("cookie")), user.id)
    .first<number>("v");
  if (verified === null) {
    return jsonError(401, "unauthenticated", "no active session — sign in first");
  }

  // Mint — `account:<owner-id>:admin`, aud="account", stateless (no registry
  // row). `<owner-id>` = the session user; the scope keys the token to exactly
  // this account owner.
  const scopes = [accountAdminScope(user.id)];
  const minted = await signAccessToken(db, {
    sub: user.id,
    scopes,
    audience: ACCOUNT_TOKEN_AUDIENCE,
    clientId: ACCOUNT_TOKEN_CLIENT_ID,
    issuer: deps.issuer,
    vaultScope: [],
    ttlSeconds: ACCOUNT_TOKEN_TTL_SECONDS,
    now: deps.now,
    // Stateless, so a legacy-account claim can't revoke it; the /account/*
    // gate refuses a token minted unverified once the account is verified.
    emailVerified: verified === 1,
  });

  return jsonResponse(
    { token: minted.token, expires_at: minted.expiresAt, scopes, aud: ACCOUNT_TOKEN_AUDIENCE },
    200,
    // No browser cache — the token rotates per-mint; a stale 200 from a
    // back/forward navigation could hand the app a long-expired JWT.
    { "cache-control": "no-store" },
  );
}
