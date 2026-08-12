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
  /**
   * Non-null while the row exists SOLELY to receive an import (stamped by the
   * import door at creation, cleared on import success — migration 0019). The
   * import door's retry-reuse gate: only a still-pending row may be re-imported
   * into; a populated vault (NULL) gets the "already taken" refusal instead of
   * a blow-away.
   */
  importPendingAt: string | null;
  /**
   * The immutable identity behind the (renameable-in-future) `name` slug —
   * identity-keying groundwork for handles/sharing (migration 0020). Every row
   * `createVault` mints carries one; typed nullable only to stay honest about
   * legacy rows from before the migration's backfill ran (should never be null
   * in practice once the migration has applied — see the migration file).
   */
  vaultId: string | null;
}

interface Row {
  name: string;
  owner_user_id: string;
  created_at: string;
  import_pending_at: string | null;
  vault_id: string | null;
}

function rowToVault(r: Row): Vault {
  return {
    name: r.name,
    ownerUserId: r.owner_user_id,
    createdAt: r.created_at,
    importPendingAt: r.import_pending_at ?? null,
    vaultId: r.vault_id ?? null,
  };
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

export interface VaultDeleteD1Summary {
  vaultRowsDeleted: number;
  usageRowsDeleted: number;
  snapshotRowsDeleted: number;
  tokensRevoked: number;
  grantsRewritten: number;
  grantsDropped: number;
}

/**
 * A LIKE pattern matching any scope string that CONTAINS the `vault:<name>:`
 * segment prefix — the cheap D1-side CANDIDATE filter for the delete cascade,
 * never the authority (see {@link deleteVaultD1Rows}). Wildcards in the name are
 * escaped (`ESCAPE '\'`) because `_` is a LIKE single-char wildcard and legacy
 * rows can predate today's stricter slug gate.
 */
function vaultScopeLikePattern(vaultName: string): string {
  return `%vault:${vaultName.replace(/[\\%_]/g, "\\$&")}:%`;
}

/** The scope strings in a space-delimited scope column, as an array. */
function splitScopes(scopes: string): string[] {
  return scopes.split(" ").filter((s) => s.length > 0);
}

/**
 * Remove the identity-side rows for one owned vault after the vault worker has
 * erased the DO and its R2 prefix. Ports the self-hosted hub twin's cascade
 * (`handleDeleteVault` → `revokeTokensNamingVault` + `rewriteGrantsRemovingVault`)
 * onto D1, in the same order — identity artifacts first, ownership claim last,
 * because revocation is the safe direction if a later step fails.
 *
 * MATCHING IS EXACT SCOPE-SEGMENT COMPARISON, NEVER `LIKE` — the twin's rule,
 * kept here. A scope names this vault iff it parses as the three-part
 * `vault:<name>:<verb>` grammar ({@link vaultScopeName}) with `<name>` equal;
 * a substring hit is not enough. The one adaptation for D1 is that a `LIKE`
 * pattern PRE-FILTERS which rows are read (the hub reads the whole unrevoked
 * registry into memory; cloud's is multi-tenant and must not). That is sound in
 * exactly one direction: every true match contains the `vault:<name>:` substring,
 * so the pattern is a superset — it can over-fetch candidates, never miss one,
 * and the JS check discards the extras. Do not promote the pattern to the
 * decision; `xvault:foo:read` and `account:<id>:vaults:foo:read` are precisely
 * the strings that must survive it.
 *
 * Grants are REWRITTEN, not dropped, when they name the vault — a `grants` row
 * is keyed (user, client) and its scope set spans every vault that user ever
 * approved for that client, so dropping the row over one vault would silently
 * revoke the client's consent on the user's OTHER vaults. The row is deleted
 * only when the rewrite empties it. This also closes the re-create hole: a
 * client that held `vault:<name>:read` must face the consent screen again if a
 * vault of that name is ever created anew.
 *
 * Token registry rows are retained and marked `revoked_at`, matching the
 * identity worker's existing revocation-list convention. Only rows that were
 * still live contribute to `tokensRevoked`, so a retry after a D1 failure is
 * idempotent — as are the row deletes.
 *
 * Every write runs in ONE D1 batch (D1 has no interactive transaction; a batch
 * is the atomic unit). A batch failure therefore leaves the whole cascade
 * available for a retry, which matters because the preceding vault destroy is
 * intentionally irreversible but itself idempotent. The two candidate SELECTs
 * run before it and write nothing.
 *
 * REMAINING RESIDUE, stated rather than implied away: the cascade sweeps the
 * three-part `vault:<name>:<verb>` grammar the twin defines, and NOT cloud's
 * own composed ACCOUNT scopes (`account:<id>:vaults:<name>:<verb>`), which have
 * no hub counterpart. Those are inert against a deleted vault — the account-MCP
 * fan-out resolves vaults through `listVaultsForOwner` at call time, so a dead
 * name reaches nothing — but they would still cover a same-name vault created
 * later without a fresh consent. Sweeping them safely means reasoning about
 * `recordGrant`'s family-replace narrowing semantics (grants.ts), which is a
 * consent-model change and wants its own review, not a wiring slice (cloud#226).
 */
export async function deleteVaultD1Rows(
  db: D1Database,
  ownerUserId: string,
  name: string,
  now: Date = new Date(),
): Promise<VaultDeleteD1Summary> {
  const vaultName = name.toLowerCase();
  const pattern = vaultScopeLikePattern(vaultName);

  const [tokenCandidates, grantCandidates] = await Promise.all([
    db
      .prepare("SELECT jti, scopes FROM tokens WHERE revoked_at IS NULL AND scopes LIKE ? ESCAPE '\\'")
      .bind(pattern)
      .all<{ jti: string; scopes: string }>(),
    db
      .prepare("SELECT user_id, client_id, scopes FROM grants WHERE scopes LIKE ? ESCAPE '\\'")
      .bind(pattern)
      .all<{ user_id: string; client_id: string; scopes: string }>(),
  ]);

  const jtis = (tokenCandidates.results ?? [])
    .filter((r) => splitScopes(r.scopes).some((s) => vaultScopeName(s) === vaultName))
    .map((r) => r.jti);

  const statements: D1PreparedStatement[] = [];

  // Revoke in chunks: SQLite caps bound parameters (~999), and a busy account
  // can hold more live vault tokens than one IN-list should carry.
  const REVOKE_CHUNK = 100;
  const revokeStatementCount = Math.ceil(jtis.length / REVOKE_CHUNK);
  for (let i = 0; i < jtis.length; i += REVOKE_CHUNK) {
    const chunk = jtis.slice(i, i + REVOKE_CHUNK);
    statements.push(
      db
        .prepare(
          `UPDATE tokens SET revoked_at = ? WHERE revoked_at IS NULL AND jti IN (${chunk.map(() => "?").join(", ")})`,
        )
        .bind(now.toISOString(), ...chunk),
    );
  }

  let grantsRewritten = 0;
  let grantsDropped = 0;
  for (const row of grantCandidates.results ?? []) {
    const scopes = splitScopes(row.scopes);
    const kept = scopes.filter((s) => vaultScopeName(s) !== vaultName);
    if (kept.length === scopes.length) continue; // LIKE over-fetch — not a real match.
    if (kept.length === 0) {
      statements.push(
        db.prepare("DELETE FROM grants WHERE user_id = ? AND client_id = ?").bind(row.user_id, row.client_id),
      );
      grantsDropped++;
    } else {
      statements.push(
        db
          .prepare("UPDATE grants SET scopes = ? WHERE user_id = ? AND client_id = ?")
          .bind(kept.join(" "), row.user_id, row.client_id),
      );
      grantsRewritten++;
    }
  }

  const mirrorsAt = statements.length;
  statements.push(
    db.prepare("DELETE FROM vault_usage WHERE vault_name = ?").bind(vaultName),
    db.prepare("DELETE FROM vault_snapshots WHERE vault_name = ?").bind(vaultName),
    db.prepare("DELETE FROM vaults WHERE name = ? AND owner_user_id = ?").bind(vaultName, ownerUserId),
  );

  const results = await db.batch(statements);
  let tokensRevoked = 0;
  for (let i = 0; i < revokeStatementCount; i++) tokensRevoked += results[i]?.meta.changes ?? 0;
  return {
    tokensRevoked,
    grantsRewritten,
    grantsDropped,
    usageRowsDeleted: results[mirrorsAt]?.meta.changes ?? 0,
    snapshotRowsDeleted: results[mirrorsAt + 1]?.meta.changes ?? 0,
    vaultRowsDeleted: results[mirrorsAt + 2]?.meta.changes ?? 0,
  };
}

/**
 * Claim a vault name for a user. Validates slug + reserved, then inserts. Throws
 * VaultNameInvalidError (bad name) or VaultNameTakenError (name already owned by
 * anyone — the PK collision). The DO comes into existence on first access.
 *
 * `opts.importPending` (import door only): stamp `import_pending_at` IN the
 * insert — atomically, so a crash can never leave an import-created row without
 * its flag (a flagless row refuses reuse, stranding the name). Cleared via
 * {@link clearImportPending} on import success; every other creation path
 * leaves it NULL.
 *
 * Every insert also mints a `vault_id` (migration 0020) — the immutable
 * identity groundwork for handles/sharing. `randomUUID()` (opaque, 122 bits of
 * randomness) is plenty collision-resistant for this fleet size; a UNIQUE
 * index on the column is the belt.
 */
export async function createVault(
  db: D1Database,
  rawName: string,
  ownerUserId: string,
  now: Date = new Date(),
  opts: { importPending?: boolean } = {},
): Promise<Vault> {
  const check = validateVaultName(rawName);
  if (!check.ok) throw new VaultNameInvalidError(check.reason, rawName);
  const name = check.name;
  const createdAt = now.toISOString();
  const importPendingAt = opts.importPending === true ? createdAt : null;
  const vaultId = randomUUID();
  try {
    await db
      .prepare(
        "INSERT INTO vaults (name, owner_user_id, created_at, import_pending_at, vault_id) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(name, ownerUserId, createdAt, importPendingAt, vaultId)
      .run();
  } catch (err) {
    // UNIQUE/PK collision → the name is taken (by this user or another). (A
    // vault_id collision would also land here — indistinguishable by message,
    // but at 122 bits of randomness this branch is name-collision in practice.)
    const msg = err instanceof Error ? err.message : String(err);
    if (/UNIQUE|constraint|PRIMARY/i.test(msg)) throw new VaultNameTakenError(name);
    throw err;
  }
  return { name, ownerUserId, createdAt, importPendingAt, vaultId };
}

/**
 * Clear the import-pending marker after a SUCCESSFUL import — the vault now
 * holds real content, so the import door's retry-reuse gate must close (a later
 * import naming this vault gets the "already taken" refusal, never a blow-away).
 * Owner-scoped for defense-in-depth (a mismatched owner is a no-op).
 */
export async function clearImportPending(db: D1Database, name: string, ownerUserId: string): Promise<void> {
  await db
    .prepare("UPDATE vaults SET import_pending_at = NULL WHERE name = ? AND owner_user_id = ?")
    .bind(name.toLowerCase(), ownerUserId)
    .run();
}

/**
 * The vault a single scope NAMES, or null when it names none. The one place the
 * `vault:<name>:<verb>` grammar is decided — twin of the hub's `vaultScopeName`.
 * Returns null for an unnamed vault scope (`vault:read`), for a non-vault scope,
 * and for every ACCOUNT scope family (`account:<id>:vaults:<name>:<verb>` has
 * five parts and a `vaults` head, so it can never be mistaken for this one).
 */
export function vaultScopeName(scope: string): string | null {
  const parts = scope.split(":");
  if (parts.length === 3 && parts[0] === "vault" && parts[1] && parts[2] && VAULT_VERBS.has(parts[2])) {
    return parts[1];
  }
  return null;
}

/** The distinct named vaults referenced by a scope set (`vault:<name>:<verb>`). */
export function namedVaultsInScopes(scopes: readonly string[]): string[] {
  const names = new Set<string>();
  for (const s of scopes) {
    const named = vaultScopeName(s);
    if (named !== null) names.add(named);
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
