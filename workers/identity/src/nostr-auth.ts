/**
 * NIP-98 owner sign-in for the identity worker (T-414, Parachute 0.9.1): an account's owner can be a Nostr key.
 * A request carrying `Authorization: Nostr <base64(url) event>` proves the caller holds the private key for
 * `event.pubkey`; that key maps to an account through `user_pubkeys` (migration 0030).
 *
 * This is a port of parachute-core's one verifier (packages/hub/src/nostr-event.ts + nostr-http-auth.ts), with
 * the same checks in the same order, so a signer that works against a box works here:
 *   - the event parses with the same shape limits (hex id/pubkey/sig, ≤1 KiB content, ≤20 tags);
 *   - its id is the NIP-01 hash of its fields and its BIP-340 signature verifies (@noble/curves, as core);
 *   - kind 27235; `created_at` within ±60 s of now;
 *   - `u` equals this request's URL exactly, `method` equals its method;
 *   - `payload` equals sha256(body) hex when there is a body, and is absent when there isn't;
 *   - the event id has not been spent: core keeps that set in process memory; a Worker runs many isolates, so
 *     here it is a D1 row (`nostr_events_seen`), inserted once — a second insert of the same id fails, and the
 *     request is refused. Rows expire after twice the window.
 * The replay row is written last, after every other check, so a malformed or mis-addressed event can't burn
 * someone else's id. It is checked before the account lookup, so an unknown key's id is spent too.
 */
import { schnorr } from "@noble/curves/secp256k1.js";
import type { PaidPlanId } from "./oauth-shared.ts";
import { createUser, getUserById, type User } from "./users.ts";

export const NOSTR_AUTH_KIND = 27235;
export const NIP98_MAX_SKEW_SECONDS = 60;
/** How long a spent event id is remembered: twice the window, plus a second (core's NIP98_REPLAY_TTL_MS). */
export const NIP98_REPLAY_TTL_MS = 2 * NIP98_MAX_SKEW_SECONDS * 1000 + 1000;

const MAX_EVENT_CONTENT_LEN = 1024;
const MAX_EVENT_TAGS = 20;
const MAX_TAG_ELEMENTS = 8;
const MAX_TAG_ELEMENT_LEN = 512;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export type NostrAuthFailure =
  | "malformed_authorization"
  | "invalid_event"
  | "bad_signature"
  | "wrong_kind"
  | "expired"
  | "replayed"
  | "url_mismatch"
  | "method_mismatch"
  | "payload_mismatch"
  | "unknown_pubkey";

export class NostrAuthError extends Error {
  override name = "NostrAuthError";
  constructor(
    public readonly code: NostrAuthFailure,
    message: string,
  ) {
    super(message);
  }
}

/** A D1/SQLite uniqueness violation (PRIMARY KEY or UNIQUE), as opposed to any other failure. */
export function isUniqueViolation(err: unknown): boolean {
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT_(PRIMARYKEY|UNIQUE)/i.test(err instanceof Error ? err.message : String(err));
}

export function isNostrAuthorization(req: Request): boolean {
  return /^Nostr\s+/i.test(req.headers.get("authorization") ?? "");
}

function isWellFormedUtf16(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      if (i + 1 >= s.length) return false;
      const n = s.charCodeAt(i + 1);
      if (n < 0xdc00 || n > 0xdfff) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/** Core's `parseNostrEvent`: the shape, before any cryptography. */
export function parseNostrEvent(raw: unknown): NostrEvent | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.pubkey !== "string" || !HEX64.test(o.pubkey)) return null;
  if (typeof o.id !== "string" || !HEX64.test(o.id)) return null;
  if (typeof o.sig !== "string" || !HEX128.test(o.sig)) return null;
  if (typeof o.kind !== "number" || !Number.isSafeInteger(o.kind) || o.kind < 0) return null;
  if (typeof o.created_at !== "number" || !Number.isSafeInteger(o.created_at) || o.created_at < 0) return null;
  if (typeof o.content !== "string" || o.content.length > MAX_EVENT_CONTENT_LEN || !isWellFormedUtf16(o.content)) {
    return null;
  }
  if (!Array.isArray(o.tags) || o.tags.length > MAX_EVENT_TAGS) return null;
  const tags: string[][] = [];
  for (const tag of o.tags) {
    if (!Array.isArray(tag) || tag.length > MAX_TAG_ELEMENTS) return null;
    for (const el of tag) {
      if (typeof el !== "string" || el.length > MAX_TAG_ELEMENT_LEN || !isWellFormedUtf16(el)) return null;
    }
    tags.push(tag as string[]);
  }
  return { id: o.id, pubkey: o.pubkey, created_at: o.created_at, kind: o.kind, tags, content: o.content, sig: o.sig };
}

const hexBytes = (hex: string) => Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)));
const toHex = (b: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return toHex(await crypto.subtle.digest("SHA-256", bytes));
}

/** NIP-01 event id: sha256 of `[0, pubkey, created_at, kind, tags, content]`. */
export function nostrEventId(e: Omit<NostrEvent, "id" | "sig">): Promise<string> {
  return sha256Hex(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]));
}

function tagValue(e: NostrEvent, name: string): string | null {
  for (const t of e.tags) if (t[0] === name) return t[1] ?? null;
  return null;
}

/** The event in `Authorization: Nostr <base64 | base64url JSON>`. */
export function extractNostrEvent(req: Request): NostrEvent {
  const m = (req.headers.get("authorization") ?? "").match(/^Nostr\s+(\S+)$/i);
  if (!m) throw new NostrAuthError("malformed_authorization", "Authorization must be 'Nostr <base64 event>'");
  let raw: unknown;
  try {
    const b64 = m[1]!.replace(/-/g, "+").replace(/_/g, "/");
    raw = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0))));
  } catch {
    throw new NostrAuthError("malformed_authorization", "Nostr token is not base64 JSON");
  }
  const event = parseNostrEvent(raw);
  if (!event) throw new NostrAuthError("invalid_event", "Nostr event rejected: malformed");
  return event;
}

/**
 * Verify `event` is a NIP-98 event for exactly this request, and spend its id. Throws {@link NostrAuthError}.
 * `body` is the raw request body (empty for none). Does not resolve an account.
 */
export async function verifyNostrRequest(
  db: D1Database,
  req: Request,
  event: NostrEvent,
  body: Uint8Array,
  now: Date = new Date(),
): Promise<void> {
  const { id: _id, sig: _sig, ...unsigned } = event;
  if ((await nostrEventId(unsigned)) !== event.id) {
    throw new NostrAuthError("bad_signature", "Nostr event id does not match payload");
  }
  let ok = false;
  try {
    ok = schnorr.verify(hexBytes(event.sig), hexBytes(event.id), hexBytes(event.pubkey));
  } catch {
    ok = false;
  }
  if (!ok) throw new NostrAuthError("bad_signature", "Nostr event signature is invalid");
  if (event.kind !== NOSTR_AUTH_KIND) throw new NostrAuthError("wrong_kind", `Nostr event kind must be ${NOSTR_AUTH_KIND}`);
  if (Math.abs(now.getTime() - event.created_at * 1000) > NIP98_MAX_SKEW_SECONDS * 1000) {
    throw new NostrAuthError("expired", "Nostr event created_at is outside the 60s window");
  }
  if (tagValue(event, "u") !== req.url) throw new NostrAuthError("url_mismatch", "Nostr event u tag must equal this request URL");
  const method = tagValue(event, "method");
  if (!method || method.toUpperCase() !== req.method.toUpperCase()) {
    throw new NostrAuthError("method_mismatch", "Nostr event method tag must equal this request method");
  }
  const payload = tagValue(event, "payload");
  if (body.byteLength === 0) {
    if (payload) throw new NostrAuthError("payload_mismatch", "Nostr event payload tag must be absent when the body is empty");
  } else if (payload !== (await sha256Hex(body))) {
    throw new NostrAuthError("payload_mismatch", "Nostr event payload tag must be sha256 hex of the request body");
  }
  // Spend the id. Expired rows go first so the table stays small; then a plain INSERT, whose PRIMARY KEY
  // conflict is the replay signal (one statement, so two racing requests can't both succeed).
  const stamp = now.toISOString();
  await db.prepare("DELETE FROM nostr_events_seen WHERE expires_at <= ?").bind(stamp).run();
  try {
    await db
      .prepare("INSERT INTO nostr_events_seen (event_id, expires_at) VALUES (?, ?)")
      .bind(event.id, new Date(now.getTime() + NIP98_REPLAY_TTL_MS).toISOString())
      .run();
  } catch (err) {
    if (isUniqueViolation(err)) throw new NostrAuthError("replayed", "Nostr event id has already been used");
    throw err;
  }
}

/**
 * The key-only owner's address: a placeholder on the reserved `.invalid` domain (RFC 2606), which never routes, so no
 * mail reaches it. One spelling for every place that makes or recognises it (drip.ts keeps its own SQL twin).
 */
export const PLACEHOLDER_DOMAIN = "@nostr.invalid";
export function placeholderAddress(pubkey: string): string {
  return `${pubkey}${PLACEHOLDER_DOMAIN}`;
}
export function isPlaceholderAddress(email: string): boolean {
  return email.trim().toLowerCase().endsWith(PLACEHOLDER_DOMAIN);
}

/** The account a verified pubkey signs in as, or null. */
export async function findPubkeyUser(db: D1Database, pubkey: string): Promise<User | null> {
  const row = await db.prepare("SELECT user_id FROM user_pubkeys WHERE pubkey = ?").bind(pubkey).first<{ user_id: string }>();
  return row ? getUserById(db, row.user_id) : null;
}

/**
 * The account `pubkey` signs in as. A linked key resolves to its account. An unlinked key is refused — except the
 * single-owner bootstrap: when the deploy names `ownerPubkey` (env OWNER_PUBKEY), this IS that key, and the
 * instance has no accounts at all, the owner's key-only account is created (no password, no mail; the address is
 * a placeholder on the reserved `.invalid` domain, which never routes) and the key linked, in one batch whose
 * guard re-checks "no accounts" so two racing first sign-ins make one owner.
 */
export async function resolvePubkeyAccount(
  db: D1Database,
  pubkey: string,
  opts: { ownerPubkey?: string; adminPubkeys?: readonly string[]; ownerPlan?: PaidPlanId; now?: Date },
): Promise<User> {
  // An admin key (env ADMIN_PUBKEYS, single-owner deploys only) signs in as the owner's account while it is listed.
  // It is read from the config at every sign-in and never stored as a link, so dropping it from ADMIN_PUBKEYS is
  // the whole revocation: the owner's own key and account are untouched. On an empty instance an admin's first
  // sign-in makes the owner's account exactly as the owner's own first sign-in would: linked to OWNER_PUBKEY, never
  // to the admin key, so the account is the owner's from its first moment.
  if (opts.ownerPubkey && opts.adminPubkeys?.includes(pubkey) && pubkey !== opts.ownerPubkey) {
    return (await findPubkeyUser(db, opts.ownerPubkey)) ?? bootstrapOwner(db, opts.ownerPubkey, opts.now, opts.ownerPlan);
  }
  const linked = await findPubkeyUser(db, pubkey);
  if (linked) return linked;
  if (!opts.ownerPubkey || opts.ownerPubkey !== pubkey) {
    throw new NostrAuthError("unknown_pubkey", "Nostr pubkey is not linked to an account");
  }
  return bootstrapOwner(db, pubkey, opts.now, opts.ownerPlan);
}

/** The single-owner bootstrap: on an instance with no accounts, the key-only owner's account, `pubkey` linked. */
async function bootstrapOwner(db: D1Database, pubkey: string, nowOpt?: Date, plan?: PaidPlanId): Promise<User> {
  const opts = { now: nowOpt };
  const anyUser = await db.prepare("SELECT 1 AS x FROM users LIMIT 1").first<number>("x");
  if (anyUser !== null) {
    throw new NostrAuthError("unknown_pubkey", "Nostr pubkey is not linked to an account (link it from your account)");
  }
  const now = opts.now ?? new Date();
  let user: User;
  try {
    user = await createUser(db, placeholderAddress(pubkey), "", now, { emailVerified: true });
  } catch {
    // A racing first sign-in by the same key made the placeholder address first.
    const winner = await findPubkeyUser(db, pubkey);
    if (winner) return winner;
    throw new NostrAuthError("unknown_pubkey", "Nostr pubkey is not linked to an account");
  }
  // Link only if this is still the one account (a racing bootstrap made its own user first: undo ours).
  const linkedNow = await db
    .prepare(
      `INSERT INTO user_pubkeys (pubkey, user_id, label, created_at)
       SELECT ?, ?, 'owner', ? WHERE (SELECT COUNT(*) FROM users) = 1`,
    )
    .bind(pubkey, user.id, now.toISOString())
    .run();
  if (!linkedNow.meta.changes) {
    await db.prepare("DELETE FROM users WHERE id = ?").bind(user.id).run();
    const winner = await findPubkeyUser(db, pubkey);
    if (winner) return winner;
    throw new NostrAuthError("unknown_pubkey", "Nostr pubkey is not linked to an account");
  }
  // OWNER_PLAN (a single-owner deploy with billing off): the owner's entitlements from the first moment, no trial clock.
  if (plan) {
    await db.prepare("UPDATE users SET plan = ?, pending_plan = NULL, plan_downgrade_at = NULL WHERE id = ?").bind(plan, user.id).run();
    return { ...user, plan, pendingPlan: null, planDowngradeAt: null } as User;
  }
  return user;
}

/** Verify a signed request and resolve its account (the sign-in). */
export async function authenticateNostrRequest(
  db: D1Database,
  req: Request,
  opts: { ownerPubkey?: string; adminPubkeys?: readonly string[]; ownerPlan?: PaidPlanId; now?: Date },
): Promise<{ user: User; pubkey: string }> {
  const event = extractNostrEvent(req);
  const body = new Uint8Array(await req.arrayBuffer());
  await verifyNostrRequest(db, req, event, body, opts.now);
  const user = await resolvePubkeyAccount(db, event.pubkey, opts);
  return { user, pubkey: event.pubkey };
}
