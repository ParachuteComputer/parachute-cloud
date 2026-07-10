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
 *      NULL` — so a SUSPENDED owner's session is refused here (the read-time
 *      chokepoint, admin.ts suspend lever), and no account token is minted. No
 *      session / suspended → 401.
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
 * the read-time suspend chokepoint above. A stateless mint avoids a DB write on
 * every re-mint, matching the internal `parachute-console` mints (vault-call.ts).
 */
import { csrfTokenValid, CSRF_FIELD } from "./csrf.ts";
import { ACCOUNT_TOKEN_AUDIENCE } from "./account-auth.ts";
import { isSameOriginRequest, jsonResponse, resolveBoundOrigins, type OAuthDeps } from "./oauth-shared.ts";
import { sessionUser } from "./session-user.ts";
import { signAccessToken } from "./tokens.ts";

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
  // Gate 1 — session. `sessionUser` refuses a missing cookie AND a suspended
  // owner (findActiveSession's suspended_at JOIN) — the mint chokepoint.
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
  });

  return jsonResponse(
    { token: minted.token, expires_at: minted.expiresAt, scopes, aud: ACCOUNT_TOKEN_AUDIENCE },
    200,
    // No browser cache — the token rotates per-mint; a stale 200 from a
    // back/forward navigation could hand the app a long-expired JWT.
    { "cache-control": "no-store" },
  );
}
