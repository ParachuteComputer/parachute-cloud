/**
 * `/account/pubkeys` — link a Nostr key to an account, so it can sign in with NIP-98 on `POST /account/token`
 * (T-414). This is how an existing account (an email owner on Parachute Cloud, or the email owner an
 * own-Cloudflare deploy started with) comes to be owned by an npub. The box's twin is the hub's
 * `/api/account/pubkeys` ceremony and `parachute auth link-pubkey`.
 *
 *   GET    /account/pubkeys            → 200 {pubkeys: [{pubkey, label, created_at}]}
 *   POST   /account/pubkeys            {event, label?} → 201 {pubkey, label, created_at}  (200 if already yours)
 *   DELETE /account/pubkeys/<hex>      → 200 {pubkey}; 404 if it isn't yours; 409 if it is a key-only account's last key
 *
 * Linking needs both halves: the account's own bearer (`requireAccount(…, "admin")`), and proof of the key — `event`
 * is a NIP-98 event signed by the key for THIS request (`u` = this URL, `method` POST, no `payload`), checked by the
 * same verifier as sign-in (signature, kind, ±60 s, single-use id). So a stolen account token can't link a key its
 * holder doesn't have, and a signature captured elsewhere can't link a key to the wrong account.
 * A key already linked to another account is refused (409): one key signs in as one account.
 */
import { requireAccount, readJsonBody } from "./account-api.ts";
import { NostrAuthError, parseNostrEvent, verifyNostrRequest } from "./nostr-auth.ts";
import { jsonResponse, type OAuthDeps } from "./oauth-shared.ts";
import { getUserById } from "./users.ts";

const err = (status: number, error: string, message: string) =>
  jsonResponse({ error, message }, status, { "cache-control": "no-store" });
const ok = (body: unknown, status = 200) => jsonResponse(body, status, { "cache-control": "no-store" });

export async function handleAccountPubkeysList(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const auth = await requireAccount(db, req, deps, "admin");
  if (!auth.ok) return auth.response;
  const res = await db
    .prepare("SELECT pubkey, label, created_at FROM user_pubkeys WHERE user_id = ? ORDER BY created_at, pubkey")
    .bind(auth.accountId)
    .all<{ pubkey: string; label: string | null; created_at: string }>();
  return ok({ pubkeys: res.results ?? [] });
}

export async function handleAccountPubkeyLink(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const auth = await requireAccount(db, req, deps, "admin");
  if (!auth.ok) return auth.response;
  const body = await readJsonBody(req);
  const event = parseNostrEvent(body.event);
  if (!event) return err(400, "invalid_request", "event: a NIP-98 event (kind 27235) signed by the key, for this request");
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
  } catch {
    return err(409, "pubkey_taken", "this key already signs in as another account");
  }
  return ok({ pubkey: event.pubkey, label, created_at: createdAt }, 201);
}

export async function handleAccountPubkeyUnlink(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const auth = await requireAccount(db, req, deps, "admin");
  if (!auth.ok) return auth.response;
  const pubkey = /^\/account\/pubkeys\/([0-9a-f]{64})\/?$/.exec(new URL(req.url).pathname)?.[1];
  if (!pubkey) return err(404, "pubkey_not_found", "no such key on this account");
  const mine = await db
    .prepare("SELECT 1 AS x FROM user_pubkeys WHERE pubkey = ? AND user_id = ?")
    .bind(pubkey, auth.accountId)
    .first<number>("x");
  if (mine === null) return err(404, "pubkey_not_found", "no such key on this account");
  // A key-only account (no password; the OWNER_PUBKEY bootstrap) would lock itself out by removing its last key.
  const user = await getUserById(db, auth.accountId);
  const count = await db.prepare("SELECT COUNT(*) AS n FROM user_pubkeys WHERE user_id = ?").bind(auth.accountId).first<number>("n");
  if (user && user.passwordHash === "" && (count ?? 0) <= 1) {
    return err(409, "last_sign_in", "this is the account's only way to sign in; link another key first");
  }
  await db.prepare("DELETE FROM user_pubkeys WHERE pubkey = ? AND user_id = ?").bind(pubkey, auth.accountId).run();
  return ok({ pubkey });
}
