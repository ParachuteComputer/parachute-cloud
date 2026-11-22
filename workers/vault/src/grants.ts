/**
 * The grants this vault keeps (T-476, typed keys; core docs/SPEC-1.0-grants.md §7.3, first slice), the cloud twin of
 * the box's `packages/vault/src/grants-api.ts` and auth.ts `underGrant`, over the engine's own table (core grants.ts,
 * made the first time a grant is filed, so a vault with none never has it).
 *
 *   GET    /api/grants          → 200 {grants: [{id, origin, state, grantee, by, types, deny, expires_at, revoked_at, created_at}]}
 *   GET    /api/grants/<id>     → 200 the grant | 404
 *   PUT    /api/grants/<id>     {grantee, types, expires_at} → 201 filed | 200 the same grant again | 409 id_taken | 400
 *   DELETE /api/grants/<id>     → 200 {id, state: "revoked", revoked_at}; final; 404 when never filed
 *
 * Admin on every method, and never for a narrowed credential: a grant is no grantee's to read or change (§4.4). The
 * identity worker files a typed key's grant here before it hands the key out, and ends it when the key is ended
 * (identity account-keys.ts, vault-grants.ts), each with its first-party admin hop.
 *
 * On every request a token under a grant (`permissions.grant`) is checked against the row here, now
 * ({@link narrowToGrant}): ended, expired, unknown, or another key's → 401 `grant_ended` on this very request; in force
 * → the request is narrowed to the grant's types (its tag scope, rest/tag-scope.ts), its write kept only when the grant
 * may write, never admin.
 */
import { checkDoorGrant, endGrant, fileDoorGrant, getGrant, grantReach, grantState, listGrants, type DoorGrant } from "@openparachute/core/src/grants.js";
import type { Store } from "@openparachute/core/src/types.js";
import { hasScopeForVault, type AuthResult } from "./auth.js";

type GrantDb = Parameters<typeof getGrant>[0];
const dbOf = (store: Store) => store.db as unknown as GrantDb;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });

const view = (g: DoorGrant, now = new Date()) => ({ ...g, state: grantState(g, now) });

/** `/api/grants[/<id>]`. `sub` is the path after `/grants`. `onEnd` runs after a grant is ended (close its sockets). */
export async function handleGrants(
  req: Request,
  store: Store,
  sub: string,
  vaultName: string,
  auth: AuthResult,
  onEnd: (id: string) => void,
): Promise<Response> {
  if (!hasScopeForVault(auth.scopes, vaultName, "admin") || auth.scoped_tags !== null || (auth.grant ?? null) !== null) {
    return json(
      {
        error: "Forbidden",
        error_type: "insufficient_scope",
        message: `The grants a vault keeps are its owner's: this needs 'vault:${vaultName}:admin' on the whole vault.`,
        required_scope: "vault:admin",
      },
      403,
    );
  }
  const db = dbOf(store);
  if (sub === "" || sub === "/") {
    if (req.method !== "GET") return json({ error: "method_not_allowed", message: "use GET" }, 405, { Allow: "GET" });
    return json({ grants: listGrants(db).map((g) => view(g)) });
  }
  let id: string;
  try {
    id = decodeURIComponent(sub.slice(1));
  } catch {
    return json({ error: "invalid_request", message: "the grant id in the path is not valid percent-encoding" }, 400);
  }
  if (req.method === "GET") {
    const g = getGrant(db, id);
    return g ? json(view(g)) : json({ error: "not_found", message: `no grant ${id} here` }, 404);
  }
  if (req.method === "PUT") {
    const body = await req.json().catch(() => undefined);
    const checked = checkDoorGrant(id, body);
    if ("problem" in checked) return json({ error: "invalid_statement", message: checked.problem }, 400);
    const r = fileDoorGrant(db, id, checked.grant);
    if (r === "taken") return json({ error: "id_taken", message: `grant ${id} was filed before with other content, or has ended; an id is never reused` }, 409);
    return json(view(getGrant(db, id)!), r === "filed" ? 201 : 200);
  }
  if (req.method === "DELETE") {
    const g = endGrant(db, id);
    if (!g) return json({ error: "not_found", message: `no grant ${id} here` }, 404);
    onEnd(id);
    return json({ id, state: "revoked", revoked_at: g.revoked_at });
  }
  return json({ error: "method_not_allowed", message: "use GET, PUT or DELETE" }, 405, { Allow: "GET, PUT, DELETE" });
}

/** Is the grant `id` in force for key `keyName` here, now? */
export function grantInForce(store: Store, id: string, keyName: string | null | undefined): DoorGrant | null {
  let g: DoorGrant | null = null;
  try {
    g = getGrant(dbOf(store), id);
  } catch (err) {
    console.warn(`[grants] grant could not be read: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  // The grant is this key's (identity names it after the key and signs the key's name into the token): one filed for
  // another key under this id never opens to it.
  if (!g || grantState(g) !== "in_force" || g.grantee !== `key:${keyName ?? ""}`) return null;
  return g;
}

export function grantEnded(): Response {
  return json({ error: "grant_ended", message: "This key's grant has ended, or isn't this vault's. Ask the vault's owner for a new key." }, 401);
}

/**
 * The one checkpoint for a token under a grant: read the grant now; refuse when it isn't in force; otherwise narrow
 * the credential to the grant's types (`scoped_tags`, which every read and write path here passes), keeping write
 * only when the grant can write, and never admin (§4.4). A credential with no grant passes unchanged.
 */
export function narrowToGrant(auth: AuthResult, store: Store, vaultName: string): AuthResult | { error: Response } {
  if (auth.grant === undefined || auth.grant === null) return auth;
  const g = grantInForce(store, auth.grant, auth.keyName);
  if (!g) return { error: grantEnded() };
  const reach = grantReach(g);
  const levels = reach.write ? ["read", "write"] : ["read"];
  const scopes = auth.scopes.filter((s) => levels.some((l) => s === `vault:${vaultName}:${l}`));
  return { ...auth, scopes, permission: reach.write && auth.permission === "full" ? "full" : "read", scoped_tags: reach.types };
}
