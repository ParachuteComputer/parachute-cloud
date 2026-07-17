/**
 * Handles — the GitHub owner-model namespace (ratified 2026-07-16). A user may
 * CLAIM a single global handle; `/u/<handle>/vault/<name>` becomes an alias
 * route to their vault in a later wave. Users and orgs share ONE namespace
 * (`owners.handle UNIQUE`, migration 0022) exactly as GitHub does.
 *
 * This module is the code side of the DB-code split (see the migration): the
 * charset/shape/reserved rules live HERE (not a CHECK constraint) so tightening
 * the policy never needs a schema migration, mirroring the `plan`/`role`
 * posture. It owns validation, the reserved list, the email-derived suggestion,
 * and the claim itself (`claimHandle`) — the `createVault`/`VaultNameTakenError`
 * pattern in vaults.ts, adapted to the owners table.
 *
 * WAVE A1 SCOPE: claiming works and persists, but nothing on the wire yet
 * advertises or resolves a `/u/` URL — an account without a handle is
 * byte-for-byte unaffected. Renames + the 30-day redirect hold are Wave E.
 */
import { randomUUID } from "./crypto.ts";

/**
 * Handle shape: `[a-z0-9-]{3,30}` with NO leading or trailing hyphen (the
 * ratified §5 policy — a strictening WITHIN the ratified charset, exactly as
 * GitHub does; flagged for the reviewer as one line to relax). The regex
 * encodes all three rules at once: an alnum first char, an alnum last char, and
 * 1–28 charset chars between — so total length is 3–30 and neither end is a
 * hyphen. Consecutive interior hyphens are permitted (the policy only fences the
 * ends). Handles are STRICTLY this — the legacy loose vault-name charsets
 * (VAULT_SLUG_RE / the router's addressing regex) never apply to a handle.
 */
export const HANDLE_RE = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;

/**
 * Names that can never be a claimed handle — the union (plan §5 starter list)
 * of the vault reserved set (vaults.ts RESERVED_VAULT_NAMES), the vault worker's
 * RESERVED_SUBDOMAINS, every route-manifest ceremony prefix, and the standard
 * squat set (platform words, roles, RFC-2142 mailbox names). Reserved from day
 * one so a first-party surface word can never be squatted. `well-known` is a
 * valid handle shape (interior hyphen) and so must be listed explicitly.
 */
export const RESERVED_HANDLES = new Set<string>([
  "admin", "administrator", "abuse", "account", "accounts", "api", "app", "apps",
  "assets", "auth", "billing", "blog", "cloud", "console", "contact", "dashboard",
  "demo", "dev", "developer", "docs", "download", "email", "everyone", "export",
  "ghost", "guide", "guides", "health", "help", "home", "hub", "id", "identity",
  "import", "info", "internal", "legal", "login", "logout", "mail", "mcp", "me",
  "my", "news", "noreply", "notes", "oauth", "official", "openparachute", "ops",
  "operator", "org", "orgs", "owner", "owners", "parachute", "postmaster", "press",
  "pricing", "privacy", "root", "search", "security", "settings", "share", "shared",
  "signin", "signup", "site", "sse", "staff", "staging", "static", "status",
  "support", "surface", "surfaces", "system", "team", "teams", "terms", "test",
  "u", "unsubscribe", "user", "users", "vault", "vaults", "webmaster", "well-known",
  "www", "you",
]);

export type HandleError = "invalid" | "reserved";

/**
 * Validate a candidate handle (claim/check-time). Returns the canonical
 * (trimmed, lowercased) handle or a reason. Case is folded before both the
 * shape test and the reserved check, so `Foo` canonicalizes to `foo` (GitHub
 * behaviour) rather than being rejected for its case.
 */
export function validateHandle(raw: string): { ok: true; handle: string } | { ok: false; reason: HandleError } {
  const handle = raw.trim().toLowerCase();
  if (!HANDLE_RE.test(handle)) return { ok: false, reason: "invalid" };
  if (RESERVED_HANDLES.has(handle)) return { ok: false, reason: "reserved" };
  return { ok: true, handle };
}

/**
 * Derive a friendly starting handle from an email's local part — surfaced as
 * `suggested` in GET /account/handle and NEVER auto-claimed (the user accepts or
 * edits it, then the check/claim endpoints validate for real). Guarantees a
 * syntactically valid, non-reserved result:
 *   local-part -> lowercase -> strip [^a-z0-9-] -> trim hyphens -> clamp to 30;
 * a too-short/empty result gets a neutral floor, and a reserved result gets a
 * numeric suffix until it clears. Pure (no DB) — availability is the check
 * endpoint's job, not the suggestion's.
 */
export function suggestHandleFromEmail(email: string): string {
  const local = (email.split("@")[0] ?? "").toLowerCase();
  const cleaned = local
    .replace(/[^a-z0-9-]/g, "")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30)
    .replace(/-+$/g, ""); // the slice may have left a trailing hyphen
  // Floor a too-short/empty local part with a neutral, non-reserved token
  // ("member" is not in RESERVED_HANDLES) so the base is always a valid handle.
  let base = cleaned.length >= 3 ? cleaned : `${cleaned}member`.slice(0, 30);
  base = base.replace(/^-+|-+$/g, "");
  if (base.length < 3 || !HANDLE_RE.test(base)) base = "member";
  if (!RESERVED_HANDLES.has(base) && HANDLE_RE.test(base)) return base;
  // Reserved: append the smallest numeric suffix that clears, trimming the base
  // to keep within 30 chars (and off a trailing hyphen before the digits).
  for (let n = 1; n <= 9999; n++) {
    const suffix = String(n);
    const trimmed = base.slice(0, 30 - suffix.length).replace(/-+$/g, "");
    const candidate = `${trimmed}${suffix}`;
    if (HANDLE_RE.test(candidate) && !RESERVED_HANDLES.has(candidate)) return candidate;
  }
  return "member"; // unreachable in practice (base is a valid non-reserved handle by construction)
}

/**
 * The handle currently claimed by the account whose `users.owner_id` is
 * `ownerId` — a single-hop lookup on the owners table. `null` for an unclaimed
 * account (a `null` ownerId short-circuits without a query).
 */
export async function getOwnerHandle(db: D1Database, ownerId: string | null): Promise<string | null> {
  if (!ownerId) return null;
  const row = await db.prepare("SELECT handle FROM owners WHERE owner_id = ?").bind(ownerId).first<{ handle: string }>();
  return row?.handle ?? null;
}

/**
 * Whether a canonical handle is unclaimed (no owners row). Availability is
 * public information (GitHub-style) — the check endpoint composes this with
 * validation + the reserved list. Pass a CANONICAL (validated) handle.
 */
export async function handleIsAvailable(db: D1Database, handle: string): Promise<boolean> {
  const row = await db.prepare("SELECT 1 FROM owners WHERE handle = ?").bind(handle).first<{ 1: number }>();
  return row === null;
}

export class HandleInvalidError extends Error {
  constructor(public readonly reason: HandleError, raw: string) {
    super(`handle "${raw}" rejected: ${reason}`);
    this.name = "HandleInvalidError";
  }
}
export class HandleTakenError extends Error {
  constructor(handle: string) {
    super(`handle "${handle}" is already claimed`);
    this.name = "HandleTakenError";
  }
}
export class HandleAlreadySetError extends Error {
  constructor(userId: string) {
    super(`account "${userId}" already has a handle`);
    this.name = "HandleAlreadySetError";
  }
}

/**
 * Claim a handle for a user (claim-once — rename is Wave E). Validates shape +
 * reserved (HandleInvalidError), refuses an account that already holds a handle
 * (HandleAlreadySetError), then INSERTs the owners row and points
 * `users.owner_id` at it in ONE atomic D1 batch. A UNIQUE-violation race (two
 * accounts claiming the same handle at once) rolls the batch back and surfaces
 * HandleTakenError — the `createVault`/`VaultNameTakenError` pattern
 * (vaults.ts). The UPDATE's `owner_id IS NULL` guard is defense-in-depth against
 * the check-then-claim window above it.
 *
 * Returns the canonical handle + the minted owner_id on success.
 */
export async function claimHandle(
  db: D1Database,
  userId: string,
  rawHandle: string,
  now: Date = new Date(),
): Promise<{ handle: string; ownerId: string }> {
  const check = validateHandle(rawHandle);
  if (!check.ok) throw new HandleInvalidError(check.reason, rawHandle);
  const handle = check.handle;

  // Claim-once: refuse an account that already points at an owner row. Read
  // fresh (not the caller's loaded User) so the check reflects the DB; the
  // batch's `owner_id IS NULL` guard closes the residual check-then-act window.
  const existing = await db.prepare("SELECT owner_id FROM users WHERE id = ?").bind(userId).first<{
    owner_id: string | null;
  }>();
  if (existing?.owner_id) throw new HandleAlreadySetError(userId);

  const ownerId = randomUUID();
  const claimedAt = now.toISOString();
  try {
    await db.batch([
      db
        .prepare("INSERT INTO owners (owner_id, handle, kind, claimed_at) VALUES (?, ?, 'user', ?)")
        .bind(ownerId, handle, claimedAt),
      db.prepare("UPDATE users SET owner_id = ? WHERE id = ? AND owner_id IS NULL").bind(ownerId, userId),
    ]);
  } catch (err) {
    // UNIQUE on owners.handle (the namespace lock) → the handle was claimed
    // concurrently; the batch rolled back atomically. An owner_id PK collision
    // would also land here — indistinguishable by message, but at 122 bits of
    // randomness this branch is a handle collision in practice.
    const msg = err instanceof Error ? err.message : String(err);
    if (/UNIQUE|constraint|PRIMARY/i.test(msg)) throw new HandleTakenError(handle);
    throw err;
  }
  return { handle, ownerId };
}
