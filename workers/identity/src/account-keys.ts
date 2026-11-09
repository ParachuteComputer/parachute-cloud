/**
 * `/account/keys` — named app keys (T-414, Parachute 0.9.1 "keys by name"), the cloud twin of parachute-core's
 * `packages/hub/src/account-keys.ts`, with the same wire shapes so one client works against a box, Parachute
 * Cloud and a single-owner deploy on your own Cloudflare:
 *
 *   POST   /account/keys          {name, vault, can: "read"|"write", expires_in?}
 *                                 → 201 {name, vault, can, status, scopes, token, created_at, expires_at, last_used_at, revoked_at}
 *   GET    /account/keys          → 200 {keys: [{name, vault, can, status, created_at, expires_at, last_used_at, revoked_at}]}
 *   DELETE /account/keys/<name>   → 200 {name, revoked_at}   (idempotent; 404 for a name this account doesn't have)
 *
 * What holds it safe:
 *   - **Never admin.** `can` is read or write and the body may carry nothing else; the scopes are built here
 *     (`vault:<v>:read`, plus `:write`), `vault_scope=[v]`, `aud=vault.<v>`, `client_id=parachute-app-key` — not
 *     the first-party `parachute-console`, so a key can never reach the vault's `/api/internal/*` seams.
 *   - **Only the account mints, and only for its own vaults.** `requireAccount(…, "admin")`, the one `/account/*`
 *     gate; the vault must be owned by the bearer's account (404 otherwise, the same answer as no such vault).
 *   - **A name is one key per account, forever** (app_keys PRIMARY KEY (user_id, name)); the D1 batch writes the
 *     registry row and the key row together, so a racing mint of the same name fails whole.
 *   - **Revocation.** The `tokens` row is revoked, so the public revocation list carries the jti and every vault
 *     isolate refuses it within its 60 s cache. Then the vault's Durable Object is told directly
 *     (`POST /api/internal/keys/revoke`), and it refuses the key on its very next request. If that push fails the
 *     list still ends the key within the minute; the response says which (`refused_now`).
 *   - **Last use** is seen where the key is spent, in the vault's Durable Object (at most one storage write a
 *     minute per key); the list asks each vault with a live key (`GET /api/internal/keys/used`, first-party,
 *     bounded by a timeout) and keeps the newest time in D1.
 *   - **It outlives a signing-key rotation**: the key row records its `kid`, and JWKS keeps a retired signing key
 *     while a live app key needs it (signing-keys.ts).
 *
 * Long-lived: one year by default and at most; `expires_in` (seconds) can shorten it.
 */
import { requireAccount, readJsonBody } from "./account-api.ts";
import { jsonResponse, type OAuthDeps } from "./oauth-shared.ts";
import { signAccessToken } from "./tokens.ts";
import { callVaultApi } from "./vault-call.ts";
import { userOwnsVault } from "./vaults.ts";

export const APP_KEY_CLIENT_ID = "parachute-app-key";
export const APP_KEY_MAX_TTL_SECONDS = 365 * 24 * 60 * 60;
export const APP_KEY_MIN_TTL_SECONDS = 60;
export const APP_KEY_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const VAULT_NAME_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
const BODY_FIELDS = new Set(["name", "vault", "can", "expires_in"]);
/** How long the list waits for one vault's last-use answer before showing what D1 has. */
const LAST_USED_TIMEOUT_MS = 3000;

interface AppKeyRow {
  name: string;
  jti: string;
  vault_name: string;
  can: "read" | "write";
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

const err = (status: number, error: string, message: string) =>
  jsonResponse({ error, message }, status, { "cache-control": "no-store" });
const ok = (body: unknown, status = 200) => jsonResponse(body, status, { "cache-control": "no-store" });

function view(r: AppKeyRow, now: Date) {
  const status = r.revoked_at ? "revoked" : r.expires_at <= now.toISOString() ? "expired" : "active";
  return {
    name: r.name,
    vault: r.vault_name,
    can: r.can,
    status,
    created_at: r.created_at,
    expires_at: r.expires_at,
    last_used_at: r.last_used_at,
    revoked_at: r.revoked_at,
  };
}

// The registry's revocation (vault delete, account delete, a family sweep) also ends an app key: read it live.
const ROWS_SQL = `SELECT a.name, a.jti, a.vault_name, a.can, a.created_at, a.expires_at, a.last_used_at,
         COALESCE(a.revoked_at, t.revoked_at) AS revoked_at
    FROM app_keys a LEFT JOIN tokens t ON t.jti = a.jti
   WHERE a.user_id = ?`;

export async function handleAccountKeyMint(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const auth = await requireAccount(db, req, deps, "admin");
  if (!auth.ok) return auth.response;
  const userId = auth.accountId;
  const body = await readJsonBody(req);
  const extra = Object.keys(body).filter((k) => !BODY_FIELDS.has(k));
  if (extra.length) {
    return err(400, "invalid_request", `unknown field(s): ${extra.join(", ")}; an app key takes name, vault, can and expires_in`);
  }
  const { name, vault, can, expires_in } = body;
  if (typeof name !== "string" || !APP_KEY_NAME_RE.test(name)) {
    return err(400, "invalid_name", "name: letters, digits, '.', '_' and '-', up to 80, starting with a letter or digit");
  }
  if (typeof vault !== "string" || !VAULT_NAME_RE.test(vault)) {
    return err(400, "invalid_request", "vault: the name of one of your vaults");
  }
  if (can !== "read" && can !== "write") {
    return err(400, "invalid_scope", 'can: "read" or "write"; an app key is never admin');
  }
  let ttl = APP_KEY_MAX_TTL_SECONDS;
  if (expires_in !== undefined) {
    if (typeof expires_in !== "number" || !Number.isInteger(expires_in) || expires_in < APP_KEY_MIN_TTL_SECONDS || expires_in > APP_KEY_MAX_TTL_SECONDS) {
      return err(400, "invalid_request", `expires_in: whole seconds, ${APP_KEY_MIN_TTL_SECONDS} to ${APP_KEY_MAX_TTL_SECONDS}`);
    }
    ttl = expires_in;
  }
  if (!(await userOwnsVault(db, userId, vault))) {
    return err(404, "vault_not_found", `you have no vault named "${vault}"`);
  }
  const taken = await db.prepare("SELECT 1 AS x FROM app_keys WHERE user_id = ? AND name = ?").bind(userId, name).first<number>("x");
  if (taken !== null) {
    return err(409, "name_taken", `a key called "${name}" already exists (revoked keys keep their names); pick another`);
  }

  const scopes = can === "write" ? [`vault:${vault}:read`, `vault:${vault}:write`] : [`vault:${vault}:read`];
  const now = deps.now?.() ?? new Date();
  const signed = await signAccessToken(db, {
    sub: userId,
    scopes,
    audience: `vault.${vault}`,
    clientId: APP_KEY_CLIENT_ID,
    issuer: deps.issuer,
    vaultScope: [vault],
    ttlSeconds: ttl,
    now: () => now,
  });
  const createdAt = now.toISOString();
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO tokens (jti, user_id, subject, client_id, scopes, expires_at, created_at, created_via)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'app_key')`,
        )
        .bind(signed.jti, userId, name, APP_KEY_CLIENT_ID, scopes.join(" "), signed.expiresAt, createdAt),
      db
        .prepare(
          `INSERT INTO app_keys (user_id, name, jti, vault_name, can, kid, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(userId, name, signed.jti, vault, can, signed.kid, createdAt, signed.expiresAt),
    ]);
  } catch {
    // The batch is one transaction: a racing mint of the same name lost the PRIMARY KEY, and nothing was written.
    return err(409, "name_taken", `a key called "${name}" already exists; pick another`);
  }
  const row: AppKeyRow = {
    name,
    jti: signed.jti,
    vault_name: vault,
    can,
    created_at: createdAt,
    expires_at: signed.expiresAt,
    last_used_at: null,
    revoked_at: null,
  };
  return ok({ ...view(row, now), scopes, token: signed.token }, 201);
}

/** Ask each vault holding a live key of this account when its keys were last used; keep the newest in D1. */
async function refreshLastUsed(db: D1Database, deps: OAuthDeps, userId: string, rows: AppKeyRow[], now: Date): Promise<void> {
  const live = rows.filter((r) => !r.revoked_at && r.expires_at > now.toISOString());
  const vaults = [...new Set(live.map((r) => r.vault_name))];
  const seen = new Map<string, string>();
  await Promise.all(
    vaults.map(async (vaultName) => {
      try {
        const res = await callVaultApi(db, deps, {
          userId,
          vaultName,
          method: "GET",
          apiPath: "/api/internal/keys/used",
          verb: "admin",
          signal: AbortSignal.timeout(LAST_USED_TIMEOUT_MS),
        });
        if (!res.ok) return;
        const used = ((await res.json()) as { used?: Record<string, unknown> }).used ?? {};
        for (const [jti, at] of Object.entries(used)) if (typeof at === "string") seen.set(jti, at);
      } catch {
        // Best-effort: a slow or sleeping vault shows the last time D1 recorded.
      }
    }),
  );
  const updates: D1PreparedStatement[] = [];
  for (const r of live) {
    const at = seen.get(r.jti);
    if (at && (!r.last_used_at || at > r.last_used_at)) {
      r.last_used_at = at;
      updates.push(db.prepare("UPDATE app_keys SET last_used_at = ? WHERE jti = ?").bind(at, r.jti));
    }
  }
  if (updates.length) await db.batch(updates);
}

export async function handleAccountKeysList(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const auth = await requireAccount(db, req, deps, "admin");
  if (!auth.ok) return auth.response;
  const now = deps.now?.() ?? new Date();
  const res = await db.prepare(`${ROWS_SQL} ORDER BY a.created_at, a.name`).bind(auth.accountId).all<AppKeyRow>();
  const rows = res.results ?? [];
  await refreshLastUsed(db, deps, auth.accountId, rows, now);
  return ok({ keys: rows.map((r) => view(r, now)) });
}

export async function handleAccountKeyRevoke(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const auth = await requireAccount(db, req, deps, "admin");
  if (!auth.ok) return auth.response;
  const m = /^\/account\/keys\/([^/]+)\/?$/.exec(new URL(req.url).pathname);
  let name: string;
  try {
    name = decodeURIComponent(m?.[1] ?? "");
  } catch {
    return err(404, "key_not_found", "no such key");
  }
  const row = await db.prepare(`${ROWS_SQL} AND a.name = ?`).bind(auth.accountId, name).first<AppKeyRow>();
  if (!row) return err(404, "key_not_found", `you have no app key called "${name}"`);
  const stamp = (deps.now?.() ?? new Date()).toISOString();
  await db.batch([
    db.prepare("UPDATE tokens SET revoked_at = ? WHERE jti = ? AND revoked_at IS NULL").bind(stamp, row.jti),
    db.prepare("UPDATE app_keys SET revoked_at = ? WHERE jti = ? AND revoked_at IS NULL").bind(stamp, row.jti),
  ]);
  const after = await db.prepare(`${ROWS_SQL} AND a.name = ?`).bind(auth.accountId, name).first<AppKeyRow>();
  // Tell the vault now, so the next request is refused rather than the one after its revocation cache refreshes.
  let refusedNow = false;
  try {
    const res = await callVaultApi(db, deps, {
      userId: auth.accountId,
      vaultName: row.vault_name,
      method: "POST",
      apiPath: "/api/internal/keys/revoke",
      verb: "admin",
      jsonBody: { jti: row.jti, expires_at: row.expires_at },
      signal: AbortSignal.timeout(LAST_USED_TIMEOUT_MS),
    });
    refusedNow = res.ok;
    await res.body?.cancel().catch(() => {});
  } catch {
    refusedNow = false;
  }
  if (!refusedNow) console.warn(`event=app_key_revoke_push_failed vault=${row.vault_name}`);
  return ok({ name, revoked_at: after?.revoked_at ?? stamp, refused_now: refusedNow });
}
