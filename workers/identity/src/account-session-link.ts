/**
 * `POST /account/session-link` (T-442, Parachute 0.9.1): browser sign-in for a key-only owner on a single-owner door.
 *
 * On a single-owner door (env OWNER_PUBKEY) the owner signs in with a Nostr key at `POST /account/token` and nowhere
 * else: no password, a placeholder `<pubkey>@nostr.invalid` address no mail reaches. `/oauth/authorize` needs a
 * browser session, so without this no OAuth app (a Claude connector) could ever pass the consent screen. The owner
 * trades their account token for a one-time link; opening it in a browser signs that browser in through the sign-in
 * link's own verify (`GET /auth/verify`, auth-handlers.ts) and lands on `next`, typically the pending
 * `/oauth/authorize?...` request, which then shows consent.
 *
 *   POST /account/session-link   Authorization: Bearer <account token>   {"next": "/oauth/authorize?..."}  (body optional)
 *   → 200 {url, expires_at, next}   cache-control: no-store
 *
 * The link is a full account session, so read as an attacker would:
 *   - **Only on a single-owner door.** Without OWNER_PUBKEY (Parachute Cloud) the route is the router's 404, the same
 *     answer as an unknown path (index.ts). Hosted accounts have mail; they sign in with a link or code.
 *   - **Only the account's own top-level credential mints.** `requireAccount(…, "admin")` (a live, unsuspended,
 *     undeleted account; aud=account, so an app key, a vault token or an OAuth app's vault token is a 401), then the
 *     first-party client id `parachute-account` (an OAuth app that holds `account:<id>:admin` is a 403), then no
 *     delegated principal on the token (see {@link carriesDelegatedPrincipal}). A NIP-98 header is not accepted
 *     here: there is one way to the account credential (`/account/token`, with its replay and rate fences), and this
 *     route builds on it rather than growing a second signature door.
 *   - **A verified account only.** Opening a link on an unverified account would run the legacy-account claim
 *     (auth-handlers.ts claimUnverifiedAccount), so it is refused at the mint (the key-only owner is born verified).
 *   - **Single use, five minutes, stored hashed**, with no 6-digit code spelling (magic-links.ts createSessionLink).
 *   - **`next` by the sign-in link's rule** (`safeNext`): a path on this door, or an absolute URL on its origin. The
 *     sign-in link silently falls back to /console on a bad `next`; here a bad one is a 400 and nothing is minted, so
 *     a mistake is visible. Only the owner chooses `next` here (the stranger-planted `next` of the open draft
 *     parachute-cloud#366 needs a stranger to mint the link, which this route never lets them do), so it adds no
 *     path for that chain; it does not fix #366 either.
 *   - **Fenced per account** (10 per 15 minutes, fail closed: rate-limit.ts checkAndBumpSessionLink).
 *   - **No mail, `no-store`, an audit row and an ops line** naming the account and `next`'s path only (never the
 *     token, never the query, which carries the app's state).
 *   - Minting touches no other session: the owner's other browsers stay signed in.
 *
 * What a session born from the link can do: everything any session can (it is the same `sessions` row the verify
 * path makes): consent to OAuth apps, the console, `/console/security` (enrol 2FA, set a password), mint an account
 * token. If the owner has enrolled 2FA, opening the link asks for the second factor first (`finishPrimaryAuth`), as
 * an emailed link does. No consent or console page checks session age, so there is no freshness rule to meet or skip.
 */
import { decodeJwt } from "jose";
import { requireAccount } from "./account-api.ts";
import { auditStatement } from "./account-audit.ts";
import { ACCOUNT_TOKEN_CLIENT_ID } from "./account-token.ts";
import { safeNext } from "./auth-handlers.ts";
import { createSessionLink } from "./magic-links.ts";
import { jsonResponse, type OAuthDeps } from "./oauth-shared.ts";
import { checkAndBumpSessionLink } from "./rate-limit.ts";

const err = (status: number, error: string, message: string, headers: Record<string, string> = {}) =>
  jsonResponse({ error, message }, status, { "cache-control": "no-store", ...headers });

/**
 * Does this (already validated) account token speak for someone other than the owner themself? On this base the
 * owner's own tokens never carry a `permissions` claim. On the personal door's branch (door/0.9) an ADMIN_PUBKEYS
 * sign-in mints the owner's account token with `permissions.admin_pubkey`: that admin may run the account, but must
 * not open a browser session as the owner (the door refuses it changing sign-in keys for the same reason). Refusing
 * ANY `permissions` claim covers that and any future delegated principal, fail closed. When door/0.9 takes this,
 * `requireAccount`'s `adminPubkey` is the same fact; this check needs no change there.
 */
function carriesDelegatedPrincipal(req: Request): boolean {
  const token = /^Bearer\s+(.+)$/i.exec((req.headers.get("authorization") ?? "").trim())?.[1]?.trim();
  if (!token) return true;
  try {
    return decodeJwt(token).permissions !== undefined;
  } catch {
    return true;
  }
}

/** The body: nothing, or `{"next": "<same-origin path or URL>"}`. Anything else is a 400. */
async function readNext(req: Request): Promise<{ ok: true; next: string | null } | { ok: false }> {
  const text = await req.text();
  if (text.trim() === "") return { ok: true, next: null };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false };
  const keys = Object.keys(body);
  if (keys.some((k) => k !== "next")) return { ok: false };
  const next = (body as { next?: unknown }).next;
  if (next === undefined) return { ok: true, next: null };
  return typeof next === "string" ? { ok: true, next } : { ok: false };
}

export async function handleAccountSessionLink(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const auth = await requireAccount(db, req, deps, "admin");
  if (!auth.ok) return auth.response;
  if (auth.clientId !== ACCOUNT_TOKEN_CLIENT_ID || carriesDelegatedPrincipal(req)) {
    return err(403, "insufficient_scope", "a session link is minted with the owner's own account token, not an app's or an admin's");
  }
  if (!auth.user.emailVerified) {
    return err(403, "unverified_account", "this account can't open a browser session this way");
  }

  const body = await readNext(req);
  if (!body.ok) return err(400, "invalid_request", 'the body is empty or {"next": "<path on this door>"}');
  const next = body.next ?? "/console";
  if (safeNext(next, deps) !== next) {
    return err(400, "invalid_next", "next must be a path on this door (or a URL on its origin)");
  }

  const now = deps.now?.() ?? new Date();
  const fence = await checkAndBumpSessionLink(deps.rateLimiter, auth.accountId, now);
  if (!fence.allowed) {
    return err(429, "rate_limited", "too many session links; try again later", { "retry-after": String(fence.retryAfterSeconds) });
  }

  const { rawToken, expiresAt } = await createSessionLink(db, auth.user, next, now);
  // The path only: the query of an authorize request carries the app's state and PKCE challenge.
  const nextPath = new URL(next, deps.issuer).pathname;
  await (await auditStatement(db, { actor: "self", action: "session_link_minted", userId: auth.accountId, note: { next: nextPath }, now })).run();
  console.log(`event=session_link_minted user=${auth.accountId} next=${nextPath} expires_at=${expiresAt}`);

  // The issuer's own origin: on a single-owner door ISSUER == APP_ORIGIN, and `/oauth/authorize` is served there.
  const url = `${deps.issuer.replace(/\/$/, "")}/auth/verify?token=${encodeURIComponent(rawToken)}`;
  return jsonResponse({ url, expires_at: expiresAt, next }, 200, { "cache-control": "no-store" });
}
