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
 *   3. any auth code (redeemed or not) for this client + user that reaches this vault
 *      is deleted, so a code minted just before the click can't be spent after.
 */
import { parseComposedAccountScope } from "@openparachute/door-contract";
import { requireAccount } from "./account-api.ts";
import { APP_CLIENT_ID } from "./account-descriptor.ts";
import { ACCOUNT_TOKEN_CLIENT_ID } from "./account-token.ts";
import type { OAuthClient } from "./clients.ts";
import { CONSOLE_CLIENT_ID } from "./drip.ts";
import { type OAuthDeps, jsonResponse } from "./oauth-shared.ts";
import { prepareRevokeClientTokens } from "./tokens.ts";
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
  try {
    return {
      vault: decodeURIComponent(m[1]!).toLowerCase(),
      clientId: m[2] !== undefined ? decodeURIComponent(m[2]) : null,
    };
  } catch {
    return null; // a malformed %-escape is a 404, not a 500
  }
}

/** The newest token row per client for this user that reaches `vault` — one query. */
async function lastUsedByClient(db: D1Database, userId: string, vault: string): Promise<Map<string, string>> {
  const res = await db
    .prepare("SELECT client_id, scopes, created_at FROM tokens WHERE user_id = ?")
    .bind(userId)
    .all<{ client_id: string; scopes: string; created_at: string }>();
  const out = new Map<string, string>();
  for (const t of res.results ?? []) {
    if (!vaultReach(splitScopes(t.scopes), vault, userId)) continue;
    const prev = out.get(t.client_id);
    if (prev === undefined || t.created_at > prev) out.set(t.client_id, t.created_at);
  }
  return out;
}

/**
 * The SQL predicate "this row's space-separated `scopes` reach `vault`" — the
 * same rule as {@link vaultReach}, as literal token matches (`instr`, no LIKE
 * wildcards, so `_` / `%` in names can't over-match). Run INSIDE the batch so
 * a token minted between a read and the write can't slip past (no
 * read-then-revoke-by-id window).
 */
function reachesVaultSql(vault: string, userId: string): { clause: string; binds: string[] } {
  const needles = [
    ` vault:${vault}:`, // vault:<name>:<verb>
    ` account:${userId}:vaults:${vault}:`, // composed per-vault
    ` account:${userId}:vaults:${vault} `, // legacy per-vault
    ` account:${userId}:vaults:*:`, // composed wildcard
    ` account:${userId}:vaults `, // legacy blanket
  ];
  return {
    clause: `(${needles.map(() => "instr(' ' || scopes || ' ', ?) > 0").join(" OR ")})`,
    binds: needles,
  };
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
  const lastUsed = await lastUsedByClient(db, userId, vault);
  const out: VaultConnection[] = [];
  for (const row of res.results ?? []) {
    if (FIRST_PARTY_CLIENTS.has(row.client_id)) continue;
    const reach = vaultReach(splitScopes(row.scopes), vault, userId);
    if (!reach) continue;
    out.push({
      client_id: row.client_id,
      client_name: row.client_name,
      connected_at: row.granted_at,
      last_used_at: lastUsed.get(row.client_id) ?? null,
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
  attempt = 0,
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
      ? db
          .prepare("DELETE FROM grants WHERE user_id = ? AND client_id = ? AND scopes = ?")
          .bind(userId, clientId, grant.scopes)
      : db
          .prepare("UPDATE grants SET scopes = ? WHERE user_id = ? AND client_id = ? AND scopes = ?")
          .bind(remaining.join(" "), userId, clientId, grant.scopes),
  );

  // 2. Live tokens that reach this vault (every live token of this client
  //    for this user, when the connection is account-wide). Revoking the row
  //    kills the refresh token AND lists the access token's jti in the
  //    revocation document. A predicate, not a list of jtis read earlier, so a
  //    token minted a moment before the click is caught too.
  const reachSql = reachesVaultSql(vault, userId);
  const tokenFilter = reach.covers === "account" ? "" : ` AND ${reachSql.clause}`;
  const tokenBinds = reach.covers === "account" ? [] : reachSql.binds;
  const revokeIdx = stmts.length;
  stmts.push(
    db
      .prepare(
        `UPDATE tokens SET revoked_at = ? WHERE user_id = ? AND client_id = ? AND revoked_at IS NULL AND expires_at > ?${tokenFilter}`,
      )
      .bind(nowIso, userId, clientId, nowIso, ...tokenBinds),
  );

  // 3. Auth codes that reach this vault, redeemed or not — a code minted just
  //    before the click can't be spent after it, and an exchange in flight
  //    (code stamped, token not yet inserted) sees its code gone and revokes
  //    its own token (oauth-token.ts fence).
  stmts.push(
    db
      .prepare(`DELETE FROM auth_codes WHERE user_id = ? AND client_id = ?${tokenFilter}`)
      .bind(userId, clientId, ...tokenBinds),
  );

  const results = await db.batch(stmts);
  if ((results[0]?.meta.changes ?? 0) === 0 && attempt < 3) {
    // The grant changed under us (Codex T-318: a concurrent Disconnect of
    // another vault, or a fresh consent) — the guarded rewrite applied nothing,
    // so a stale read can't resurrect removed scopes. Redo from a fresh read;
    // the token revoke and code delete above are idempotent.
    const again = await disconnectVaultClient(db, userId, vault, clientId, now, attempt + 1);
    return again ?? { revokedTokens: results[revokeIdx]?.meta.changes ?? 0, covers: reach.covers };
  }
  const revokedTokens = results[revokeIdx]?.meta.changes ?? 0;
  // Ids and a count only — no scopes, no token material.
  console.log(`event=connection_disconnected user=${userId} client=${clientId} revoked_tokens=${revokedTokens}`);
  return { revokedTokens, covers: reach.covers };
}

// --- a reconnect replaces the app's earlier connection (T-307) ---------------
//
// claude.ai registers a NEW OAuth client (DCR) on every connect and reconnect.
// Each consent recorded a grant for the new client and left the old one, so
// Connected apps grew one more "Claude" row per reconnect and the old client's
// refresh token kept working for up to 30 days. A consent now retires the
// SAME app's earlier access to the vaults it covers, exactly as Disconnect
// would. "The same app" is the same registered client_name AND the same
// redirect URIs (loopback ports ignored: RFC 8252 §7.3, a CLI listens on a new
// port each run). Both are self-declared at DCR, so this is never a security
// boundary: it only acts on the signed-in person's own grants, at the moment
// they approve a connection, and a look-alike that copies the name and the
// redirect can only send codes to the real app's callback. The consent page
// says so before Allow.

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** A redirect URI with a loopback port removed, for comparing apps. */
function sameAppRedirect(uri: string): string {
  try {
    const u = new URL(uri);
    if (u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname)) u.port = "";
    return u.toString();
  } catch {
    return uri;
  }
}

function sameAppKey(redirectUris: readonly string[]): string {
  return [...new Set(redirectUris.map(sameAppRedirect))].sort().join(" ");
}

/** Which of this account's vaults a scope set reaches: named ones, or every vault. */
function grantVaults(scopes: readonly string[], userId: string): { vaults: Set<string>; accountWide: boolean } {
  const vaults = new Set<string>();
  let accountWide = false;
  for (const s of scopes) {
    const parts = s.split(":");
    if (parts.length === 3 && parts[0] === "vault" && parts[1] && VERB_RANK[parts[2]!]) {
      vaults.add(parts[1]);
      continue;
    }
    const parsed = parseComposedAccountScope(s);
    if (!parsed || parsed.id !== userId) continue;
    if (parsed.kind === "wildcard-vaults" || parsed.kind === "legacy-blanket") accountWide = true;
    else if (parsed.kind === "vault" || parsed.kind === "legacy-vault") vaults.add(parsed.vault);
  }
  return { vaults, accountWide };
}

/** An earlier connection of the same app that a consent to `scopes` replaces. */
export interface SupersededConnection {
  clientId: string;
  /** The vaults it loses, or "all" when an account-wide connection is replaced by another. */
  vaults: string[] | "all";
}

/**
 * The same app's earlier connections (other client ids, this user) that a
 * consent to `scopes` for `client` covers. A per-vault connection loses the
 * vaults the new consent reaches; an account-wide one is replaced only by
 * another account-wide consent (a single-vault reconnect is narrower, so the
 * wide one stays). Nothing when the client has no name or the scopes name no
 * vault (an unnamed pick is resolved at submit, and checked again there).
 */
export async function findSupersededConnections(
  db: D1Database,
  userId: string,
  client: Pick<OAuthClient, "clientId" | "clientName" | "redirectUris">,
  scopes: readonly string[],
): Promise<SupersededConnection[]> {
  if (!client.clientName || FIRST_PARTY_CLIENTS.has(client.clientId)) return [];
  const next = grantVaults(scopes, userId);
  if (!next.accountWide && next.vaults.size === 0) return [];
  const key = sameAppKey(client.redirectUris);
  const res = await db
    .prepare(
      `SELECT g.client_id, g.scopes, c.redirect_uris
         FROM grants g JOIN clients c ON c.client_id = g.client_id
        WHERE g.user_id = ? AND c.client_name = ? AND g.client_id <> ?`,
    )
    .bind(userId, client.clientName, client.clientId)
    .all<{ client_id: string; scopes: string; redirect_uris: string }>();
  const out: SupersededConnection[] = [];
  for (const row of res.results ?? []) {
    if (FIRST_PARTY_CLIENTS.has(row.client_id)) continue;
    let uris: string[];
    try {
      uris = JSON.parse(row.redirect_uris) as string[];
    } catch {
      continue;
    }
    if (sameAppKey(uris) !== key) continue;
    const old = grantVaults(splitScopes(row.scopes), userId);
    if (old.accountWide) {
      if (next.accountWide) out.push({ clientId: row.client_id, vaults: "all" });
      continue;
    }
    const covered = [...old.vaults].filter((v) => next.accountWide || next.vaults.has(v));
    if (covered.length > 0) out.push({ clientId: row.client_id, vaults: covered });
  }
  return out;
}

/**
 * Retire superseded connections as Disconnect does: per vault through
 * {@link disconnectVaultClient} (grant scopes, live tokens, codes, in one
 * batch each), or the whole grant + every live token + every code for an
 * account-wide one. Returns the live token rows revoked.
 */
export async function retireSupersededConnections(
  db: D1Database,
  userId: string,
  supersededBy: string,
  superseded: readonly SupersededConnection[],
  now: Date,
): Promise<number> {
  let revoked = 0;
  for (const s of superseded) {
    if (s.vaults === "all") {
      const [, tokens] = await db.batch([
        db.prepare("DELETE FROM grants WHERE user_id = ? AND client_id = ?").bind(userId, s.clientId),
        prepareRevokeClientTokens(db, userId, s.clientId, now),
        db.prepare("DELETE FROM auth_codes WHERE user_id = ? AND client_id = ?").bind(userId, s.clientId),
      ]);
      revoked += tokens?.meta.changes ?? 0;
    } else {
      for (const v of s.vaults) revoked += (await disconnectVaultClient(db, userId, v, s.clientId, now))?.revokedTokens ?? 0;
    }
    // Ids and a count only.
    console.log(`event=connection_superseded user=${userId} client=${s.clientId} by=${supersededBy}`);
  }
  return revoked;
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
