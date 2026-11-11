/**
 * `/account/pubkeys` — link a Nostr key to an account, so it can sign in with NIP-98 on `POST /account/token`
 * (T-414). This is how an existing account (an email owner on Parachute Cloud, or the email owner an
 * own-Cloudflare deploy started with) comes to be owned by an npub. The box's twin is the hub's
 * `/api/account/pubkeys` ceremony and `parachute auth link-pubkey`.
 *
 *   GET    /account/pubkeys            → 200 {pubkeys: [{pubkey, label, created_at}]}
 *   POST   /account/pubkeys            {event, label?} → 201 {pubkey, label, created_at}  (200 if already yours)
 *                                      event: kind 27235, tags u=<this URL>, method=POST, account=<your account id>
 *   DELETE /account/pubkeys/<hex>      → 200 {pubkey}; 404 if it isn't yours; 409 if it is a key-only account's last key
 *
 * Linking needs both halves: the account's own bearer (`requireAccount(…, "admin")`), and proof of the key — `event`
 * is a NIP-98 event signed by the key for THIS request (`u` = this URL, `method` POST, no `payload`) that also names
 * the account it links to (`["account", <id>]`), checked by the same verifier as sign-in (signature, kind, ±60 s,
 * single-use id). Only the account's own first-party token, on a verified account. So a stolen account token can't link a key its
 * holder doesn't have, and a signature captured elsewhere can't link a key to the wrong account.
 * A key already linked to another account is refused (409): one key signs in as one account.
 */
import { requireAccount, readJsonBody } from "./account-api.ts";
import { ACCOUNT_TOKEN_CLIENT_ID } from "./account-token.ts";
import { NostrAuthError, isPlaceholderAddress, isUniqueViolation, parseNostrEvent, verifyNostrRequest } from "./nostr-auth.ts";
import { jsonResponse, type OAuthDeps } from "./oauth-shared.ts";
import { getUserById } from "./users.ts";

const err = (status: number, error: string, message: string) =>
  jsonResponse({ error, message }, status, { "cache-control": "no-store" });
const ok = (body: unknown, status = 200) => jsonResponse(body, status, { "cache-control": "no-store" });

/** The account's own first-party token (never an OAuth app's, which may hold `account:<id>:admin`). */
async function ownerGate(db: D1Database, req: Request, deps: OAuthDeps, change = true) {
  const auth = await requireAccount(db, req, deps, "admin");
  if (!auth.ok) return auth;
  if (auth.clientId !== ACCOUNT_TOKEN_CLIENT_ID) {
    return { ok: false as const, response: err(403, "insufficient_scope", "sign-in keys are managed with your own account token") };
  }
  // An admin key (ADMIN_PUBKEYS) may list them, never change them: the owner's keys are the owner's.
  if (change && auth.adminPubkey) {
    return { ok: false as const, response: err(403, "admin_key", "an admin key can't change the account's sign-in keys; the owner does") };
  }
  return auth;
}

export async function handleAccountPubkeysList(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const auth = await ownerGate(db, req, deps, false);
  if (!auth.ok) return auth.response;
  const res = await db
    .prepare("SELECT pubkey, label, created_at FROM user_pubkeys WHERE user_id = ? ORDER BY created_at, pubkey")
    .bind(auth.accountId)
    .all<{ pubkey: string; label: string | null; created_at: string }>();
  return ok({ pubkeys: res.results ?? [] });
}

export async function handleAccountPubkeyLink(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const auth = await ownerGate(db, req, deps);
  if (!auth.ok) return auth.response;
  // An unverified account may be claimed later by its address's owner (auth-handlers.ts claimUnverifiedAccount);
  // a key linked before that would be a way back in. Link after proving the address.
  if (!auth.user.emailVerified) return err(403, "unverified_account", "verify your address before linking a sign-in key");
  const body = await readJsonBody(req);
  const event = parseNostrEvent(body.event);
  if (!event) return err(400, "invalid_request", "event: a NIP-98 event (kind 27235) signed by the key, for this request");
  // The proof names the account it links to, so a signature captured or phished for someone else's link can't
  // tie the signer's key to the wrong account.
  if (!event.tags.some((t) => t[0] === "account" && t[1] === auth.accountId)) {
    return err(401, "invalid_nostr_proof", `the event must carry the tag ["account", "${auth.accountId}"]`);
  }
  const label = body.label === undefined ? null : body.label;
  if (label !== null && (typeof label !== "string" || label.length > 80)) {
    return err(400, "invalid_request", "label: a string, up to 80 characters");
  }
  const now = deps.now?.() ?? new Date();
  try {
    // The proof is in the body, so it signs no payload: verify it as a body-less request to this URL.
    await verifyNostrRequest(db, req, event, new Uint8Array(), now);
  } catch (e) {
    if (e instanceof NostrAuthError) return err(401, "invalid_nostr_proof", `${e.code}: ${e.message}`);
    throw e;
  }
  // An ADMIN_PUBKEYS key is never linked: the config is its one switch, so removing it there revokes it.
  if (deps.adminPubkeys?.includes(event.pubkey)) {
    return err(409, "admin_pubkey", "this key signs in through ADMIN_PUBKEYS; remove it there to revoke it, not here");
  }
  const existing = await db
    .prepare("SELECT user_id, label, created_at FROM user_pubkeys WHERE pubkey = ?")
    .bind(event.pubkey)
    .first<{ user_id: string; label: string | null; created_at: string }>();
  if (existing) {
    if (existing.user_id !== auth.accountId) return err(409, "pubkey_taken", "this key already signs in as another account");
    return ok({ pubkey: event.pubkey, label: existing.label, created_at: existing.created_at });
  }
  const createdAt = now.toISOString();
  try {
    await db
      .prepare("INSERT INTO user_pubkeys (pubkey, user_id, label, created_at) VALUES (?, ?, ?, ?)")
      .bind(event.pubkey, auth.accountId, label, createdAt)
      .run();
  } catch (e) {
    if (isUniqueViolation(e)) return err(409, "pubkey_taken", "this key already signs in as another account");
    throw e;
  }
  return ok({ pubkey: event.pubkey, label, created_at: createdAt }, 201);
}

export async function handleAccountPubkeyUnlink(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const auth = await ownerGate(db, req, deps);
  if (!auth.ok) return auth.response;
  const pubkey = /^\/account\/pubkeys\/([0-9a-f]{64})\/?$/.exec(new URL(req.url).pathname)?.[1];
  if (!pubkey) return err(404, "pubkey_not_found", "no such key on this account");
  const mine = await db
    .prepare("SELECT 1 AS x FROM user_pubkeys WHERE pubkey = ? AND user_id = ?")
    .bind(pubkey, auth.accountId)
    .first<number>("x");
  if (mine === null) return err(404, "pubkey_not_found", "no such key on this account");
  // A key-only account (the OWNER_PUBKEY bootstrap: no password, a placeholder address no mail reaches) would lock
  // itself out by removing its last key. One conditional DELETE, so two racing unlinks can't remove the last two.
  const user = await getUserById(db, auth.accountId);
  const keyOnly = !!user && user.passwordHash === "" && isPlaceholderAddress(user.email);
  const res = await db
    .prepare(
      `DELETE FROM user_pubkeys WHERE pubkey = ? AND user_id = ?
         AND (? = 0 OR (SELECT COUNT(*) FROM user_pubkeys WHERE user_id = ?) > 1)`,
    )
    .bind(pubkey, auth.accountId, keyOnly ? 1 : 0, auth.accountId)
    .run();
  if (!res.meta.changes) return err(409, "last_sign_in", "this is the account's only way to sign in; link another key first");
  return ok({ pubkey });
}
