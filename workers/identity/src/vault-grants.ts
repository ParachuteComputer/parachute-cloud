/**
 * Who reaches a vault, and ending it (T-476; the cloud twin of parachute-core `packages/hub/src/vault-grants.ts`,
 * docs/SPEC-1.0-grants.md §7.1 and §7.3, first slice), the one list the app's Vault > Sharing shows:
 *
 *   GET    /account/vaults/<v>/statements        → 200 {grants: [row…], links: [], records: []}
 *   DELETE /account/vaults/<v>/statements/<id>   → 200 {id, state: "revoked", revoked_at}
 *   POST   /account/vaults/<v>/statements        → 405 (signed statements are a later slice)
 *
 * Every credential that reaches the vault is a row, each a **door grant** (§7.3, the door's word that the signed-in
 * owner agreed) in §7.1's shape: `{id, origin: "door", state, signer: null, grantee: null, by: "signer", types, deny: [],
 * expires_at, event: null}`, with what a person needs to know it by: `name`, `kind` (agent or app), `app` and `client`
 * (an OAuth app's registered name and client id), `created_at`, `last_used_at`, and `admin` when it holds admin.
 *   - a named key for this vault (`/account/keys`): id its name; `types` its own types, or `*` for the whole vault;
 *   - a key over several vaults that includes this one (the account door's): the same, at its level here;
 *   - an app connected by OAuth (oauth-connections.ts): id `oauth:<client_id>` (a key's name holds no colon), named
 *     by the app's registered name; `types: {"*": …}`.
 * Parachute's own clients (the console, the app, the account door's hops) are Parachute, not something you let in,
 * and aren't listed (oauth-connections.ts FIRST_PARTY_CLIENTS). Cloud has no members yet (sharing a vault with a
 * person is core #141's, not here).
 *
 * Ending a row: a key is revoked as `DELETE /account/keys/<name>` does (the vault refuses it on its next request, and a
 * typed key's grant ends there too); an OAuth app is disconnected from this vault (its grant, its tokens and its
 * codes, oauth-connections.ts) and the vault is told every token of it at once, so its access token, older ones
 * included, fails on the next request rather than when it runs out.
 *
 * Who may: the owner (their own account token), or this vault's own admin credential (account-keys.ts
 * vaultAdminCredential), which is what the app holds when its person manages the vault from it. That credential ends
 * only what reaches this vault alone; a key over several vaults, or an app connected to the whole account, is the
 * owner's to end. Both routes answer any origin, bearer only (no cookie is read).
 */
import { requireAccount } from "./account-api.ts";
import { ACCOUNT_TOKEN_CLIENT_ID } from "./account-token.ts";
import { appKeyRow, appKeyRows, MULTI_VAULT_KEY_VAULT, revokeAppKey, typesOf, vaultAdminCredential, withAnyOrigin } from "./account-keys.ts";
import { disconnectVaultClient, listVaultConnections } from "./oauth-connections.ts";
import { jsonResponse, type OAuthDeps } from "./oauth-shared.ts";
import { callVaultApi } from "./vault-call.ts";
import { userOwnsVault } from "./vaults.ts";

const VERBS_READ = ["read"];
const VERBS_WRITE = ["read", "create", "update", "delete"];
const OAUTH_ROW = "oauth:";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  withAnyOrigin(jsonResponse(body, status, { "cache-control": "no-store", ...headers }));
const err = (status: number, error: string, message: string) => json(status, { error, message });

/** The owner (`owner: true`), or this vault's own admin credential, for `vault`; a refusal otherwise. */
async function gate(db: D1Database, req: Request, deps: OAuthDeps, vault: string): Promise<{ accountId: string; owner: boolean } | Response> {
  const admin = await vaultAdminCredential(db, req, deps);
  if (admin) {
    if (admin.vault !== vault) return err(403, "insufficient_scope", `this credential is ${admin.vault}'s admin: another vault's list is its owner's`);
    return { accountId: admin.accountId, owner: false };
  }
  const auth = await requireAccount(db, req, deps, "admin");
  if (!auth.ok) return withAnyOrigin(auth.response);
  if (auth.clientId !== ACCOUNT_TOKEN_CLIENT_ID) return err(403, "insufficient_scope", "who reaches a vault is managed with your own account token, not an app's");
  if (!(await userOwnsVault(db, auth.accountId, vault))) return err(404, "vault_not_found", `you have no vault named "${vault}"`);
  return { accountId: auth.accountId, owner: true };
}

function state(revokedAt: string | null, expiresAt: string, now: Date): "in_force" | "revoked" | "expired" {
  if (revokedAt) return "revoked";
  return expiresAt <= now.toISOString() ? "expired" : "in_force";
}

/** A key's level in `vault`: its own vault's `can`, or its level there among several; null when it doesn't reach it. */
function levelIn(row: { vault_name: string; can: string; vaults: string | null }, vault: string): "read" | "write" | null {
  if (row.vault_name === MULTI_VAULT_KEY_VAULT) {
    try {
      const v = (JSON.parse(row.vaults ?? "{}") as Record<string, string>)[vault];
      return v === "read" || v === "write" ? v : null;
    } catch {
      return null;
    }
  }
  return row.vault_name === vault ? (row.can === "write" ? "write" : "read") : null;
}

/** Every credential that reaches `vault` for this account, as grant rows. */
export async function vaultGrantRows(db: D1Database, userId: string, vault: string, now: Date) {
  const keys = (await appKeyRows(db, userId))
    .map((r) => ({ r, level: levelIn(r, vault) }))
    .filter((x) => x.level !== null)
    .map(({ r, level }) => {
      const verbs = level === "write" ? VERBS_WRITE : VERBS_READ;
      const types = typesOf(r) ?? ["*"];
      return {
        id: r.name,
        origin: "door" as const,
        state: state(r.revoked_at, r.expires_at, now),
        signer: null,
        grantee: null,
        by: "signer" as const,
        types: Object.fromEntries(types.map((t) => [t, verbs])),
        deny: [] as string[],
        expires_at: r.expires_at,
        event: null,
        name: r.name,
        kind: r.kind === "agent" ? ("agent" as const) : ("app" as const),
        app: null as string | null,
        client: null as string | null,
        created_at: r.created_at,
        last_used_at: r.last_used_at,
      };
    });
  const apps = (await listVaultConnections(db, userId, vault)).map((c) => ({
    id: `${OAUTH_ROW}${c.client_id}`,
    origin: "door" as const,
    state: "in_force" as const,
    signer: null,
    grantee: null,
    by: "signer" as const,
    types: { "*": c.access === "read" ? VERBS_READ : VERBS_WRITE },
    deny: [] as string[],
    expires_at: null,
    event: null,
    name: c.client_name ?? c.client_id,
    kind: "app" as const,
    app: c.client_name,
    client: c.client_id,
    ...(c.access === "admin" ? { admin: true } : {}),
    ...(c.covers === "account" ? { covers: "account" } : {}),
    created_at: c.connected_at,
    last_used_at: c.last_used_at,
  }));
  return [...keys, ...apps];
}

/** Route `/account/vaults/<v>/statements[/<id>]` (any method; OPTIONS answers the preflight); null for another path. */
export async function routeVaultGrants(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response | null> {
  const m = /^\/account\/vaults\/([^/]+)\/statements(?:\/([^/]+))?\/?$/.exec(new URL(req.url).pathname);
  if (!m) return null;
  if (req.method === "OPTIONS") return anyOriginPreflight();
  let vault: string;
  let id: string | null;
  try {
    vault = decodeURIComponent(m[1]!).toLowerCase();
    id = m[2] === undefined ? null : decodeURIComponent(m[2]);
  } catch {
    return err(400, "invalid_request", "the path is not valid percent-encoding");
  }
  if (id === null && req.method !== "GET") {
    return json(405, { error: "method_not_allowed", message: "signed statements aren't taken here yet; use GET to list" }, { allow: "GET" });
  }
  if (id !== null && req.method !== "DELETE") return json(405, { error: "method_not_allowed", message: "use DELETE to end one" }, { allow: "DELETE" });
  const g = await gate(db, req, deps, vault);
  if (g instanceof Response) return g;
  const now = deps.now?.() ?? new Date();
  if (id === null) return json(200, { grants: await vaultGrantRows(db, g.accountId, vault, now), links: [], records: [] });
  return endRow(db, deps, g, vault, id, now);
}

async function endRow(db: D1Database, deps: OAuthDeps, g: { accountId: string; owner: boolean }, vault: string, id: string, now: Date): Promise<Response> {
  if (id.startsWith(OAUTH_ROW)) {
    const clientId = id.slice(OAUTH_ROW.length);
    const conn = (await listVaultConnections(db, g.accountId, vault)).find((c) => c.client_id === clientId);
    if (!conn) return err(404, "not_found", `nothing called "${id}" reaches ${vault}`);
    if (!g.owner && conn.covers === "account") return err(403, "insufficient_scope", `"${id}" reaches every vault in the account: only the owner can end it`);
    // Every token of this app for this account that is still alive: told to the vault after the disconnect, so each
    // (an older access token from before a refresh included) is refused on its next request.
    const live = (
      await db
        .prepare("SELECT jti, expires_at FROM tokens WHERE user_id = ? AND client_id = ? AND expires_at > ?")
        .bind(g.accountId, clientId, now.toISOString())
        .all<{ jti: string; expires_at: string }>()
    ).results ?? [];
    const done = await disconnectVaultClient(db, g.accountId, vault, clientId, now);
    if (!done) return err(404, "not_found", `nothing called "${id}" reaches ${vault}`);
    for (const t of live) {
      try {
        const res = await callVaultApi(db, deps, {
          userId: g.accountId,
          vaultName: vault,
          method: "POST",
          apiPath: "/api/internal/keys/revoke",
          verb: "admin",
          jsonBody: { jti: t.jti, expires_at: t.expires_at },
          signal: AbortSignal.timeout(3000),
        });
        await res.body?.cancel().catch(() => {});
        if (!res.ok) console.warn(`event=connection_end_push_failed vault=${vault} status=${res.status}`);
      } catch {
        console.warn(`event=connection_end_push_failed vault=${vault}`);
      }
    }
    return json(200, { id, state: "revoked", revoked_at: now.toISOString() });
  }
  const row = await appKeyRow(db, g.accountId, id);
  if (!row || levelIn(row, vault) === null) return err(404, "not_found", `nothing called "${id}" reaches ${vault}`);
  // A vault's admin ends only what reaches that vault and nothing else; a key over several vaults is the owner's.
  if (!g.owner && row.vault_name === MULTI_VAULT_KEY_VAULT) return err(403, "insufficient_scope", `"${id}" reaches more than ${vault}: only the owner can end it`);
  const r = await revokeAppKey(db, deps, g.accountId, row);
  return json(200, { id, state: "revoked", revoked_at: r.revoked_at });
}

/** The preflight for a bearer-only route the app calls from its own origin: any origin, no credentials. */
export function anyOriginPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
      "access-control-allow-headers": "authorization, content-type",
      "access-control-max-age": "600",
      vary: "Origin",
    },
  });
}
