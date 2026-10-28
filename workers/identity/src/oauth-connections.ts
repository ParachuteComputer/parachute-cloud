/**
 * Connected apps (T-318) — which OAuth clients hold access to one of your
 * vaults, and a way to disconnect one. The promise the consent page and the
 * app's Connect AI make ("Disconnect anytime from your vault's settings") is
 * kept here.
 *
 *   GET    /account/vaults/<name>/connections              account:<id>:read
 *   DELETE /account/vaults/<name>/connections/<client_id>  account:<id>:admin
 *
 * Bearer-gated through the SAME `requireAccount` chokepoint as every other
 * `/account/*` route, then an ownership check on the vault (one 403 for
 * "someone else's" and "doesn't exist", like the token mint — no oracle).
 *
 * WHAT COUNTS AS A CONNECTION. A row in `grants` (user approved scope-set S for
 * client C) whose scopes reach this vault: a named `vault:<name>:<verb>`, a
 * consent-narrowed account scope for this vault (`account:<id>:vaults:<name>…`),
 * or an account-wide one (`account:<id>:vaults:*:<verb>` / the legacy blanket
 * `account:<id>:vaults`) — the last kind reaches EVERY vault, so it is reported
 * with `covers: "account"`, and disconnecting it disconnects it everywhere.
 * Parachute's own first-party clients (the console, the app, the account door)
 * are never listed: they are Parachute itself, not an app you connected.
 *
 * WHAT DISCONNECT DOES, in one D1 batch (no window where the record says
 * "gone" while a credential still works):
 *   1. the grant loses this vault's scopes (or is deleted when nothing is
 *      left, or when it is account-wide) — so the next authorize asks again;
 *   2. every live token row this client holds for this user that reaches this
 *      vault is revoked. Access + refresh tokens SHARE one row/jti
 *      (oauth-token.ts), so the refresh token dies at once AND the outstanding
 *      15-minute access token's jti enters `/.well-known/parachute-revocation.json`
 *      — which the vault worker's scope-guard re-reads at most every 60 s
 *      (REVOCATION_CACHE_TTL_MS) and fails closed on. A disconnected app is
 *      refused at the vault within about a minute, not after its token runs out;
 *   3. any unredeemed auth code for this client + user that reaches this vault
 *      is deleted, so a code minted just before the click can't be spent after.
 */
import { parseComposedAccountScope } from "@openparachute/door-contract";
import { requireAccount } from "./account-api.ts";
import { APP_CLIENT_ID } from "./account-descriptor.ts";
import { ACCOUNT_TOKEN_CLIENT_ID } from "./account-token.ts";
import { CONSOLE_CLIENT_ID } from "./drip.ts";
import { type OAuthDeps, jsonResponse } from "./oauth-shared.ts";
import { userOwnsVault } from "./vaults.ts";

/** Parachute's own clients — never shown as a "connected app". */
const FIRST_PARTY_CLIENTS = new Set([CONSOLE_CLIENT_ID, APP_CLIENT_ID, ACCOUNT_TOKEN_CLIENT_ID]);

const VERB_RANK: Record<string, number> = { read: 1, write: 2, admin: 3 };

export type ConnectionCoverage = "vault" | "account";

/** How a scope set reaches one vault: the scopes that reach it, the strongest verb, and whether any is account-wide. */
export interface VaultReach {
  /** The scopes in the set that reach this vault (named or account-wide). */
  scopes: string[];
  /** The strongest vault verb among them; legacy account forms count as write. */
  access: "read" | "write" | "admin";
  /** "account" when any reaching scope covers every vault in the account. */
  covers: ConnectionCoverage;
}

/**
 * Which scopes in `scopes` reach vault `vault` for account `userId`, or null if
 * none do. Pure — the unit the list, the disconnect and the token sweep share,
 * so all three agree on what "this app can reach this vault" means.
 */
export function vaultReach(scopes: readonly string[], vault: string, userId: string): VaultReach | null {
  const reaching: string[] = [];
  let rank = 0;
  let accountWide = false;
  for (const s of scopes) {
    const parts = s.split(":");
    if (parts.length === 3 && parts[0] === "vault" && parts[1] === vault && VERB_RANK[parts[2]!]) {
      reaching.push(s);
      rank = Math.max(rank, VERB_RANK[parts[2]!]!);
      continue;
    }
    const parsed = parseComposedAccountScope(s);
    if (!parsed || parsed.id !== userId) continue;
    switch (parsed.kind) {
      case "wildcard-vaults":
        reaching.push(s);
        accountWide = true;
        rank = Math.max(rank, VERB_RANK[parsed.verb] ?? 0);
        break;
      case "legacy-blanket":
        reaching.push(s);
        accountWide = true;
        rank = Math.max(rank, VERB_RANK.write!);
        break;
      case "vault":
        if (parsed.vault === vault) {
          reaching.push(s);
          rank = Math.max(rank, VERB_RANK[parsed.verb] ?? 0);
        }
        break;
      case "legacy-vault":
        if (parsed.vault === vault) {
          reaching.push(s);
          rank = Math.max(rank, VERB_RANK.write!);
        }
        break;
      default:
        break; // vault-create / module: not access to THIS vault
    }
  }
  if (reaching.length === 0) return null;
  const access = rank >= 3 ? "admin" : rank === 2 ? "write" : "read";
  return { scopes: reaching, access, covers: accountWide ? "account" : "vault" };
}

/** One connected app, as the API returns it. */
export interface VaultConnection {
  client_id: string;
  /** The app's self-registered name (untrusted DCR `client_name`), or null. */
  client_name: string | null;
  /** When the person last approved this app (ISO-8601). */
  connected_at: string;
  /** When the app last fetched a token for this vault (≈ last active, ≤15 min granularity), or null. */
  last_used_at: string | null;
  access: "read" | "write" | "admin";
  covers: ConnectionCoverage;
  scopes: string[];
}

interface GrantJoinRow {
  client_id: string;
  scopes: string;
  granted_at: string;
  client_name: string | null;
}

interface TokenRow {
  jti: string;
  scopes: string;
  created_at: string;
  revoked_at: string | null;
  expires_at: string;
}

function splitScopes(s: string): string[] {
  return s.split(" ").filter((x) => x.length > 0);
}

function restError(status: number, error: string, message: string): Response {
  return jsonResponse({ error, message }, status, { "cache-control": "no-store" });
}

/** `/account/vaults/<name>/connections[/<client_id>]` → the parts, or null. */
function pathParts(req: Request): { vault: string; clientId: string | null } | null {
  const m = /^\/account\/vaults\/([^/]+)\/connections(?:\/([^/]+))?\/?$/.exec(new URL(req.url).pathname);
  if (!m) return null;
  return {
    vault: decodeURIComponent(m[1]!).toLowerCase(),
    clientId: m[2] !== undefined ? decodeURIComponent(m[2]) : null,
  };
}

async function tokenRowsFor(db: D1Database, userId: string, clientId: string): Promise<TokenRow[]> {
  const res = await db
    .prepare("SELECT jti, scopes, created_at, revoked_at, expires_at FROM tokens WHERE user_id = ? AND client_id = ?")
    .bind(userId, clientId)
    .all<TokenRow>();
  return res.results ?? [];
}

/** The connections that reach `vault` for `userId`, newest first. */
export async function listVaultConnections(db: D1Database, userId: string, vault: string): Promise<VaultConnection[]> {
  const res = await db
    .prepare(
      `SELECT g.client_id, g.scopes, g.granted_at, c.client_name
         FROM grants g LEFT JOIN clients c ON c.client_id = g.client_id
        WHERE g.user_id = ?
        ORDER BY g.granted_at DESC`,
    )
    .bind(userId)
    .all<GrantJoinRow>();
  const out: VaultConnection[] = [];
  for (const row of res.results ?? []) {
    if (FIRST_PARTY_CLIENTS.has(row.client_id)) continue;
    const reach = vaultReach(splitScopes(row.scopes), vault, userId);
    if (!reach) continue;
    let lastUsed: string | null = null;
    for (const t of await tokenRowsFor(db, userId, row.client_id)) {
      if (!vaultReach(splitScopes(t.scopes), vault, userId)) continue;
      if (lastUsed === null || t.created_at > lastUsed) lastUsed = t.created_at;
    }
    out.push({
      client_id: row.client_id,
      client_name: row.client_name,
      connected_at: row.granted_at,
      last_used_at: lastUsed,
      access: reach.access,
      covers: reach.covers,
      scopes: reach.scopes,
    });
  }
  return out;
}

/**
 * Disconnect `clientId` from `vault` for `userId` (see the module note for the
 * three effects). Returns null when there is no such connection, else the
 * number of live token rows revoked.
 */
export async function disconnectVaultClient(
  db: D1Database,
  userId: string,
  vault: string,
  clientId: string,
  now: Date,
): Promise<{ revokedTokens: number; covers: ConnectionCoverage } | null> {
  if (FIRST_PARTY_CLIENTS.has(clientId)) return null;
  const grant = await db
    .prepare("SELECT scopes FROM grants WHERE user_id = ? AND client_id = ?")
    .bind(userId, clientId)
    .first<{ scopes: string }>();
  if (!grant) return null;
  const grantScopes = splitScopes(grant.scopes);
  const reach = vaultReach(grantScopes, vault, userId);
  if (!reach) return null;

  const nowIso = now.toISOString();
  const stmts: D1PreparedStatement[] = [];

  // 1. The grant: an account-wide connection goes entirely (it can't be
  //    narrowed to "every vault but this one"); a vault connection loses this
  //    vault's scopes and is deleted when nothing is left.
  const reaching = new Set(reach.scopes);
  const remaining = reach.covers === "account" ? [] : grantScopes.filter((s) => !reaching.has(s));
  stmts.push(
    remaining.length === 0
      ? db.prepare("DELETE FROM grants WHERE user_id = ? AND client_id = ?").bind(userId, clientId)
      : db
          .prepare("UPDATE grants SET scopes = ? WHERE user_id = ? AND client_id = ?")
          .bind(remaining.join(" "), userId, clientId),
  );

  // 2. Live tokens that reach this vault (all of them, for an account-wide
  //    connection). Revoking the row kills the refresh token AND lists the
  //    access token's jti in the revocation document.
  const live = (await tokenRowsFor(db, userId, clientId)).filter(
    (t) => t.revoked_at === null && t.expires_at > nowIso,
  );
  const doomed = live.filter((t) => reach.covers === "account" || vaultReach(splitScopes(t.scopes), vault, userId) !== null);
  for (const t of doomed) {
    stmts.push(
      db.prepare("UPDATE tokens SET revoked_at = ? WHERE jti = ? AND revoked_at IS NULL").bind(nowIso, t.jti),
    );
  }

  // 3. Unredeemed auth codes that reach this vault.
  const codes = await db
    .prepare("SELECT code, scopes FROM auth_codes WHERE user_id = ? AND client_id = ? AND used_at IS NULL")
    .bind(userId, clientId)
    .all<{ code: string; scopes: string }>();
  for (const c of codes.results ?? []) {
    if (reach.covers === "account" || vaultReach(splitScopes(c.scopes), vault, userId) !== null) {
      stmts.push(db.prepare("DELETE FROM auth_codes WHERE code = ?").bind(c.code));
    }
  }

  await db.batch(stmts);
  // Ids and a count only — no scopes, no token material.
  console.log(`event=connection_disconnected user=${userId} client=${clientId} revoked_tokens=${doomed.length}`);
  return { revokedTokens: doomed.length, covers: reach.covers };
}

/** GET /account/vaults/<name>/connections */
export async function handleVaultConnectionsList(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const auth = await requireAccount(db, req, deps, "read");
  if (!auth.ok) return auth.response;
  const parts = pathParts(req);
  if (!parts || parts.clientId !== null) return restError(404, "not_found", "no such route");
  if (!(await userOwnsVault(db, auth.accountId, parts.vault))) {
    return restError(403, "not_owner", `You do not own a vault named "${parts.vault}".`);
  }
  const connections = await listVaultConnections(db, auth.accountId, parts.vault);
  return jsonResponse({ vault: parts.vault, connections }, 200, { "cache-control": "no-store" });
}

/** DELETE /account/vaults/<name>/connections/<client_id> */
export async function handleVaultConnectionDelete(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const auth = await requireAccount(db, req, deps, "admin");
  if (!auth.ok) return auth.response;
  const parts = pathParts(req);
  if (!parts || parts.clientId === null) return restError(404, "not_found", "no such route");
  if (!(await userOwnsVault(db, auth.accountId, parts.vault))) {
    return restError(403, "not_owner", `You do not own a vault named "${parts.vault}".`);
  }
  const result = await disconnectVaultClient(db, auth.accountId, parts.vault, parts.clientId, deps.now?.() ?? new Date());
  if (!result) return restError(404, "not_found", "That app isn't connected to this vault.");
  return jsonResponse(
    { disconnected: true, client_id: parts.clientId, covers: result.covers, revoked_tokens: result.revokedTokens },
    200,
    { "cache-control": "no-store" },
  );
}
