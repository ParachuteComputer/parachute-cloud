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
 *   - **Only on a single-owner door, only for its owner.** Without OWNER_PUBKEY (Parachute Cloud) the route is the
 *     router's 404, the same answer as an unknown path (index.ts). With it, only the account OWNER_PUBKEY is linked
 *     to may mint. Hosted accounts have mail; they sign in with a link or code.
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
 *   - **No mail, `no-store`, an audit row and an ops line** naming the account and where the link lands as a fixed
 *     label (`authorize`, `console`, `other`), never the token or the caller's `next` itself.
 *   - Minting touches no other session: the owner's other browsers stay signed in.
 *
 * Why the account token and not a NIP-98 signature on this request: a stolen 10-minute account token is already
 * lasting control of the account on this base (it can link the thief's own Nostr key at /account/pubkeys, or mint
 * year-long app keys), so a session adds no reach; and the owner already holds a token tool. A NIP-98 header here is
 * a 401 (no bearer).
 *
 * The link is built on ISSUER and `next` is checked against ISSUER's origin. The personal door sets
 * APP_ORIGIN = ISSUER, so `/oauth/authorize` is served right there; a door with a separate app origin would need
 * the one-pass redirect (oauth-authorize.ts) to find this session, which it can't (cookies are host-only).
 *
 * What a session born from the link can do: everything any session can (it is the same `sessions` row the verify
 * path makes): consent to OAuth apps, the console, `/console/security` (enrol 2FA, set a password), mint an account
 * token. If the owner has enrolled 2FA, opening the link asks for the second factor first (`finishPrimaryAuth`), as
 * an emailed link does. No consent or console page checks session age, so there is no freshness rule to meet or skip.
 */
import { decodeJwt } from "jose";
import { bearerToken, requireAccount } from "./account-api.ts";
import { auditStatement } from "./account-audit.ts";
import { ACCOUNT_TOKEN_CLIENT_ID } from "./account-token.ts";
import { safeNext } from "./auth-handlers.ts";
import { createSessionLink } from "./magic-links.ts";
import { findPubkeyUser, placeholderAddress } from "./nostr-auth.ts";
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
export function carriesDelegatedPrincipal(req: Request): boolean {
  // The same bearer `requireAccount` just validated (one parser), read again for this claim only.
  const token = bearerToken(req);
  if (!token) return true;
  try {
    return decodeJwt(token).permissions !== undefined;
  } catch {
    return true;
  }
}

/** A `next` is a path plus an authorize query; nothing legitimate comes near this. */
const MAX_NEXT_LENGTH = 4096;
const MAX_BODY_BYTES = 8192;

/** The body: nothing, or `{"next": "<same-origin path or URL>"}`. Anything else is a 400. */
async function readNext(req: Request): Promise<{ ok: true; next: string | null } | { ok: false }> {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return { ok: false };
  // Read with a running count, so a body with no declared length is cut off at the cap, not buffered whole. A body
  // that breaks off mid-read is a 400 like any other bad body.
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (req.body) {
    const reader = req.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY_BYTES) {
          await reader.cancel().catch(() => {});
          return { ok: false };
        }
        chunks.push(value);
      }
    } catch {
      return { ok: false };
    }
  }
  const text = await new Blob(chunks).text();
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
  return typeof next === "string" && next.length <= MAX_NEXT_LENGTH ? { ok: true, next } : { ok: false };
}

/** Where the link lands, as a fixed label for the audit row and the ops line: never the caller's own string. */
function nextLabel(next: string, issuer: string): "authorize" | "console" | "other" {
  const path = new URL(next, issuer).pathname;
  if (path === "/oauth/authorize") return "authorize";
  if (path === "/console" || path.startsWith("/console/")) return "console";
  return "other";
}

export async function handleAccountSessionLink(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const auth = await requireAccount(db, req, deps, "admin");
  if (!auth.ok) return auth.response;
  if (auth.clientId !== ACCOUNT_TOKEN_CLIENT_ID || carriesDelegatedPrincipal(req)) {
    return err(403, "insufficient_scope", "a session link is minted with the owner's own account token, not an app's or an admin's");
  }
  // The door's owner: the key-only account OWNER_PUBKEY's first sign-in made, known by the address it was given
  // (`<OWNER_PUBKEY>@nostr.invalid`, which no other account can hold), or the account OWNER_PUBKEY is linked to now.
  // Either holds through a rotation: link a new key and unlink the first (the address still matches), or also point
  // OWNER_PUBKEY at the new key (it is linked). Nobody else can be linked to the owner's key without its signature.
  // A single-owner door has one account; if another ever exists (an operator import, a mail sender added) it gets
  // no session this way.
  const owner =
    !!deps.ownerPubkey &&
    (auth.user.email === placeholderAddress(deps.ownerPubkey) || (await findPubkeyUser(db, deps.ownerPubkey))?.id === auth.accountId);
  if (!owner) {
    return err(403, "not_owner", "only this door's owner opens a browser session this way");
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

  // A fixed label, not the path: the audit table outlives the account and holds no names (a path can carry a
  // vault's), and the query of an authorize request carries the app's state and PKCE challenge.
  const label = nextLabel(next, deps.issuer);
  const audit = await auditStatement(db, { actor: "self", action: "session_link_minted", userId: auth.accountId, note: { next: label }, now });
  // The link and its audit row land together or not at all.
  const { rawToken, expiresAt } = await createSessionLink(db, auth.user, next, now, audit);
  console.log(`event=session_link_minted user=${auth.accountId} next=${label} expires_at=${expiresAt}`);

  // The issuer's own origin: on a single-owner door ISSUER == APP_ORIGIN, and `/oauth/authorize` is served there.
  const url = `${deps.issuer.replace(/\/$/, "")}/auth/verify?token=${encodeURIComponent(rawToken)}`;
  return jsonResponse({ url, expires_at: expiresAt, next }, 200, { "cache-control": "no-store" });
}
