/**
 * Grants — "user U approved scope-set S for client C". Port of the hub's
 * `grants.ts`. UNION-merge on record; skip consent iff every requested scope is
 * already in the grant's set (a strict superset re-prompts).
 *
 * ACCOUNT-VAULTS EXCEPTION — union-merge is one-way for a NARROWING choice: if a
 * user first grants the blanket `account:<id>:vaults` and later re-consents to a
 * NARROWED subset, a plain union would keep the blanket too, silently re-widening
 * the grant. So when a recorded consent carries account-vaults-FAMILY scopes, the
 * existing family for that grant is DROPPED before the merge (family-replace),
 * letting a later narrowing actually narrow. Every other scope family stays
 * union-merged.
 *
 * The family spans BOTH the legacy Wave A forms (`account:<id>:vaults[:<vault>]`)
 * AND the composed grammar (`account:<id>:vaults:*:<verb>`, the 5-part per-vault
 * form, and the `account:<id>:vault-create` capability) — recognized via
 * `parseComposedAccountScope`, the superset recognizer. So a composed re-consent
 * REPLACES a legacy family and vice-versa, and narrowing narrows across the
 * legacy→composed migration. MODULE grants (`account:<id>:mod:…`) are deliberately
 * EXCLUDED — they are a disjoint family whose replace semantics Phase 3 decides;
 * a vault re-consent must not wipe a module grant (or vice-versa).
 */
import { parseComposedAccountScope } from "@openparachute/door-contract";

/**
 * A vault-family account scope the re-consent REPLACES rather than unions — every
 * composed/legacy vault form and the create capability, but NOT module grants.
 */
function isAccountVaultsFamilyScope(scope: string): boolean {
  const kind = parseComposedAccountScope(scope)?.kind;
  return kind !== undefined && kind !== "module";
}

export interface Grant {
  userId: string;
  clientId: string;
  scopes: string[];
  grantedAt: string;
}

interface GrantRow {
  user_id: string;
  client_id: string;
  scopes: string;
  granted_at: string;
}

function rowToGrant(row: GrantRow): Grant {
  return {
    userId: row.user_id,
    clientId: row.client_id,
    scopes: row.scopes.split(" ").filter((s) => s.length > 0),
    grantedAt: row.granted_at,
  };
}

export async function findGrant(db: D1Database, userId: string, clientId: string): Promise<Grant | null> {
  const row = await db
    .prepare("SELECT user_id, client_id, scopes, granted_at FROM grants WHERE user_id = ? AND client_id = ?")
    .bind(userId, clientId)
    .first<GrantRow>();
  return row ? rowToGrant(row) : null;
}

/** Record a consent approval, merging `newScopes` into any existing grant. */
export async function recordGrant(
  db: D1Database,
  userId: string,
  clientId: string,
  newScopes: readonly string[],
  now: Date = new Date(),
): Promise<Grant> {
  const existing = await findGrant(db, userId, clientId);
  // Family-replace the account-vaults family when this consent carries one, so a
  // narrowing re-consent is not silently re-widened by a union with the prior
  // blanket. Every other scope family is preserved (union).
  const recordingAccountVaults = newScopes.some(isAccountVaultsFamilyScope);
  const base = (existing?.scopes ?? []).filter(
    (s) => !(recordingAccountVaults && isAccountVaultsFamilyScope(s)),
  );
  const merged = new Set<string>(base);
  for (const s of newScopes) if (s.length > 0) merged.add(s);
  const scopes = Array.from(merged).sort();
  const grantedAt = now.toISOString();
  await db
    .prepare("INSERT OR REPLACE INTO grants (user_id, client_id, scopes, granted_at) VALUES (?, ?, ?, ?)")
    .bind(userId, clientId, scopes.join(" "), grantedAt)
    .run();
  return { userId, clientId, scopes, grantedAt };
}

/**
 * True iff every requested scope is already granted. False on no grant, any
 * missing scope, or an empty request (we don't auto-approve "ask for nothing").
 */
export async function isCoveredByGrant(
  db: D1Database,
  userId: string,
  clientId: string,
  requestedScopes: readonly string[],
): Promise<boolean> {
  if (requestedScopes.length === 0) return false;
  const grant = await findGrant(db, userId, clientId);
  if (!grant) return false;
  const granted = new Set(grant.scopes);
  for (const s of requestedScopes) if (!granted.has(s)) return false;
  return true;
}

/** Delete the standing consent for (user, client). Brings consent back. */
export async function revokeGrant(db: D1Database, userId: string, clientId: string): Promise<void> {
  await db.prepare("DELETE FROM grants WHERE user_id = ? AND client_id = ?").bind(userId, clientId).run();
}
