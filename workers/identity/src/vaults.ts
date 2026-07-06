/**
 * Vault ownership — the matrix the cloud previously lacked. A user may only
 * obtain a `vault:<name>:*` token for a vault they OWN (a row in `vaults`).
 * Enforcement lives at two points:
 *   1. authorize-time (oauth-authorize.ts) — auth-code issuance refuses an
 *      unowned named vault (clean OAuth error to the client);
 *   2. token-mint (oauth-token.ts) — before signing any access token, the
 *      subject must own every named vault in the scope (defense-in-depth: also
 *      covers refresh rotation + direct code redemption).
 *
 * Creation (the console) enforces the slug charset + a reserved-name list; the
 * ownership CHECK only asks "is there a row `name` owned by `userId`", so a
 * reserved / malformed name is refused there too (no row can exist for it).
 */
import { randomUUID } from "./crypto.ts";
import { VAULT_VERBS } from "./audience.ts";

/**
 * Vault-name slug: lowercase alnum + hyphen, 2–63 chars, must start alnum.
 * Mirrors the hub's SURFACE_NAME_RE spirit (`^[a-z0-9][a-z0-9-]{1,62}$`). The
 * router/audience code accepts a looser `[A-Za-z0-9_-]+` for BACKWARD-compat
 * addressing, but new vaults are minted only through this stricter gate.
 */
export const VAULT_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

/**
 * Names that can never be a tenant vault — platform subdomains + words we want
 * to keep for first-party surfaces. A superset of the router's
 * RESERVED_SUBDOMAINS (index.ts) so a name reserved at the edge can't be claimed
 * here either. `demo` is reserved for NEW creation but grandfathered to the dev
 * user via the seed (see scripts/seed-dev-user.ts) so the dev smoke keeps working.
 */
export const RESERVED_VAULT_NAMES = new Set([
  "www", "api", "admin", "cloud", "identity", "id", "hub", "vault", "vaults",
  "mail", "smtp", "email", "dev", "demo", "u", "app", "apps", "help", "support",
  "status", "docs", "doc", "blog", "notes", "static", "assets", "cdn", "test",
  "staging", "prod", "production", "billing", "account", "accounts", "login",
  "logout", "signup", "signin", "console", "oauth", "auth", "well-known",
  "settings", "me", "root", "system",
]);

export interface Vault {
  name: string;
  ownerUserId: string;
  createdAt: string;
}

interface Row {
  name: string;
  owner_user_id: string;
  created_at: string;
}

function rowToVault(r: Row): Vault {
  return { name: r.name, ownerUserId: r.owner_user_id, createdAt: r.created_at };
}

export type VaultNameError = "invalid_slug" | "reserved";

/**
 * Validate a candidate vault name (creation-time). Returns the canonical
 * (lowercased) name or a reason. Whitespace is trimmed; case is folded before
 * both the slug test and the reserved check.
 */
export function validateVaultName(raw: string): { ok: true; name: string } | { ok: false; reason: VaultNameError } {
  const name = raw.trim().toLowerCase();
  if (!VAULT_SLUG_RE.test(name)) return { ok: false, reason: "invalid_slug" };
  if (RESERVED_VAULT_NAMES.has(name)) return { ok: false, reason: "reserved" };
  return { ok: true, name };
}

export class VaultNameTakenError extends Error {
  constructor(name: string) {
    super(`vault "${name}" already exists`);
    this.name = "VaultNameTakenError";
  }
}
export class VaultNameInvalidError extends Error {
  constructor(public readonly reason: VaultNameError, name: string) {
    super(`vault name "${name}" rejected: ${reason}`);
    this.name = "VaultNameInvalidError";
  }
}

export async function getVault(db: D1Database, name: string): Promise<Vault | null> {
  const row = await db.prepare("SELECT * FROM vaults WHERE name = ?").bind(name.toLowerCase()).first<Row>();
  return row ? rowToVault(row) : null;
}

export async function listVaultsForOwner(db: D1Database, ownerUserId: string): Promise<Vault[]> {
  const res = await db
    .prepare("SELECT * FROM vaults WHERE owner_user_id = ? ORDER BY created_at ASC")
    .bind(ownerUserId)
    .all<Row>();
  return (res.results ?? []).map(rowToVault);
}

/** How many vaults `ownerUserId` owns — the plan vault-count gate reads this. */
export async function countVaultsForOwner(db: D1Database, ownerUserId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM vaults WHERE owner_user_id = ?")
    .bind(ownerUserId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function userOwnsVault(db: D1Database, userId: string, name: string): Promise<boolean> {
  const v = await getVault(db, name);
  return v !== null && v.ownerUserId === userId;
}

/**
 * Claim a vault name for a user. Validates slug + reserved, then inserts. Throws
 * VaultNameInvalidError (bad name) or VaultNameTakenError (name already owned by
 * anyone — the PK collision). The DO comes into existence on first access.
 */
export async function createVault(
  db: D1Database,
  rawName: string,
  ownerUserId: string,
  now: Date = new Date(),
): Promise<Vault> {
  const check = validateVaultName(rawName);
  if (!check.ok) throw new VaultNameInvalidError(check.reason, rawName);
  const name = check.name;
  const createdAt = now.toISOString();
  try {
    await db
      .prepare("INSERT INTO vaults (name, owner_user_id, created_at) VALUES (?, ?, ?)")
      .bind(name, ownerUserId, createdAt)
      .run();
  } catch (err) {
    // UNIQUE/PK collision → the name is taken (by this user or another).
    const msg = err instanceof Error ? err.message : String(err);
    if (/UNIQUE|constraint|PRIMARY/i.test(msg)) throw new VaultNameTakenError(name);
    throw err;
  }
  return { name, ownerUserId, createdAt };
}

/**
 * Delete a vault OWNERSHIP row, scoped to its owner (defense-in-depth: a
 * mismatched owner is a no-op). The import door's rollback on a failed forward
 * — don't leak a half-created vault when the replay never lands. The DO's
 * SQLite (if it materialized) is left orphaned + unreachable without an
 * ownership row; a retry re-creates the name and blow-away import converges.
 */
export async function deleteVault(db: D1Database, name: string, ownerUserId: string): Promise<void> {
  await db
    .prepare("DELETE FROM vaults WHERE name = ? AND owner_user_id = ?")
    .bind(name.toLowerCase(), ownerUserId)
    .run();
}

/** The distinct named vaults referenced by a scope set (`vault:<name>:<verb>`). */
export function namedVaultsInScopes(scopes: readonly string[]): string[] {
  const names = new Set<string>();
  for (const s of scopes) {
    const parts = s.split(":");
    if (parts.length === 3 && parts[0] === "vault" && parts[1] && parts[2] && VAULT_VERBS.has(parts[2])) {
      names.add(parts[1]);
    }
  }
  return Array.from(names);
}

/**
 * The named vaults in `scopes` that `userId` does NOT own. Empty array → the
 * scope set is fully owned (or references no named vault). The enforcement
 * chokepoint for both mint paths.
 */
export async function unownedNamedVaults(
  db: D1Database,
  userId: string,
  scopes: readonly string[],
): Promise<string[]> {
  const names = namedVaultsInScopes(scopes);
  const unowned: string[] = [];
  for (const name of names) {
    if (!(await userOwnsVault(db, userId, name))) unowned.push(name);
  }
  return unowned;
}
