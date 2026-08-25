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
 *
 * THE GRANT RECORD IS ONLY HALF OF A RE-CONSENT (cloud#211). Family-replace
 * narrows what this table SAYS; it does nothing to the credentials already in
 * the client's hands, which carry their own copy of the scopes and re-mint them
 * on every rotation without ever reading this table. So a consent that MOVES
 * the vault family also revokes that client's live tokens for that user, in the
 * same D1 batch as the grant write. See `recordGrant` for why the trigger is
 * "moved" rather than "narrowed", and why it belongs here and not in the
 * consent handler.
 */
import { parseComposedAccountScope } from "@openparachute/door-contract";
import { prepareRevokeClientTokens } from "./tokens.ts";

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

/** The account-vaults family of a scope set, as a stable comparison key. */
function vaultFamilyKey(scopes: readonly string[]): string {
  return scopes.filter(isAccountVaultsFamilyScope).sort().join(" ");
}

export interface RecordedGrant extends Grant {
  /**
   * Live credential rows this consent revoked (cloud#211). 0 whenever the vault
   * family did not move — including the ordinary re-connect of an unchanged
   * app, which must NOT log anyone out.
   */
  revokedTokens: number;
}

/**
 * Record a consent approval, merging `newScopes` into any existing grant.
 *
 * WHY THIS FUNCTION, AND NOT ITS CALLERS, KILLS TOKENS (cloud#211). The
 * family-replace above fixed the GRANT RECORD — a narrowing re-consent really
 * does narrow the row. It did not fix the CREDENTIALS. An already-issued
 * refresh family keeps minting its OWN recorded scopes on every rotation:
 * `rotateAndRespond` re-signs `row.scopes` verbatim and never re-consults this
 * table (oauth-token.ts). So after a user moved a client from "any vault" down
 * to one vault, that client's outstanding token went on minting the wildcard
 * until the family expired — up to 30 days — and the consent screen's
 * "re-elect every connect" framing was stronger than what actually happened.
 *
 * This lives in `recordGrant` because `recordGrant` is the CHOKEPOINT. Put it
 * in `handleConsentSubmit` and it holds only for the two call sites that exist
 * today; put it here and "recording a consent that moves the vault family
 * invalidates that client's prior credentials" is a property of recording a
 * consent. A future third consent path inherits it instead of having to
 * remember it.
 *
 * WHY SET-INEQUALITY AND NOT A NARROWING TEST. The issue asks for this on a
 * NARROWING. Deciding narrow-vs-widen means ranking authority across two
 * grammars at once — legacy `account:<id>:vaults` against composed
 * `account:<id>:vaults:*:write` against a 5-part per-vault set — and any pair
 * a comparator ranks wrong becomes a silently retained privilege, which is the
 * exact bug wearing a disguise. Set inequality on the family cannot be ranked
 * wrong: it is total, it needs no notion of direction, and it fails toward
 * revoking. So the rule is "the family MOVED", not "the family shrank":
 *
 *   - narrowing  → moved → prior credentials die. The point of the fix.
 *   - widening   → moved → prior credentials die. Costs one rotation; the
 *                  client is mid-authorization and gets a fresh code
 *                  immediately, now carrying the wider scope it just asked for.
 *   - unchanged  → not moved → nothing revoked. This is the common re-connect,
 *                  and it must stay silent: gratuitously logging out a user's
 *                  other devices would make re-consent something to avoid.
 *   - no vault family in this consent → not moved → nothing revoked. Nothing
 *                  narrowed, so nothing to invalidate (the family-replace does
 *                  not fire either, so the grant keeps its prior family).
 *
 * ONE BATCH, because there is no correct order for two statements. Revoke-then-
 * record leaves a window where the credentials are dead but the record still
 * says "wide" — harmless, but a crash between them strands the user needing a
 * re-auth the screen already gave them. Record-then-revoke leaves the far worse
 * window: the record says "narrow" while a wide token is still spendable, which
 * is the bug, reintroduced as a race. D1's batch is its atomic unit, so neither
 * window exists.
 */
export async function recordGrant(
  db: D1Database,
  userId: string,
  clientId: string,
  newScopes: readonly string[],
  now: Date = new Date(),
): Promise<RecordedGrant> {
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

  const familyMoved = vaultFamilyKey(existing?.scopes ?? []) !== vaultFamilyKey(scopes);
  const record = db
    .prepare("INSERT OR REPLACE INTO grants (user_id, client_id, scopes, granted_at) VALUES (?, ?, ?, ?)")
    .bind(userId, clientId, scopes.join(" "), grantedAt);

  if (!familyMoved) {
    await record.run();
    return { userId, clientId, scopes, grantedAt, revokedTokens: 0 };
  }

  const [revoke] = await db.batch([prepareRevokeClientTokens(db, userId, clientId, now), record]);
  const revokedTokens = revoke?.meta.changes ?? 0;
  // Ids only. No scope strings, no jtis, no token material — this line is for
  // answering "why did that client have to re-authorize", and a count answers
  // it. Both ids are already routine in this worker's logs.
  console.log(`event=grant_vault_family_moved user=${userId} client=${clientId} revoked_tokens=${revokedTokens}`);
  return { userId, clientId, scopes, grantedAt, revokedTokens };
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
