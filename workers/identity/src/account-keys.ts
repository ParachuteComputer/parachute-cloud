/**
 * `/account/keys` — named app keys (T-414, Parachute 0.9.1 "keys by name"), the cloud twin of parachute-core's
 * `packages/hub/src/account-keys.ts`, with the same wire shapes so one client works against a box, Parachute
 * Cloud and a single-owner deploy on your own Cloudflare:
 *
 *   POST   /account/keys          {name, vault, can: "read"|"write", expires_in?, on_behalf_of?: true}
 *                                 → 201 {name, vault, can, status, scopes, token, created_at, expires_at, last_used_at, revoked_at}
 *   GET    /account/keys          → 200 {keys: [{name, vault, can, status, created_at, expires_at, last_used_at, revoked_at}]}
 *                                 (`on_behalf_of: true` is added, on the mint answer and in the list, only on a key that has it)
 *   POST   /account/keys          {name, vaults: {<v>: "read"|"write", …}, expires_in?}   (0.9.1, several vaults)
 *                                 → 201 {name, vaults, status, scopes, token, …}: aud=account, the account door only
 *   DELETE /account/keys/<name>   → 200 {name, revoked_at}   (idempotent; 404 for a name this account doesn't have)
 *
 * What holds it safe:
 *   - **Never admin.** `can` is read or write and the body may carry nothing else; the scopes are built here
 *     (`vault:<v>:read`, plus `:write`), `vault_scope=[v]`, `aud=vault.<v>`, `client_id=parachute-app-key` — not
 *     the first-party `parachute-console`, so a key can never reach the vault's `/api/internal/*` seams.
 *   - **Only the owner mints, and only for their own vaults.** `requireAccount(…, "admin")` plus the first-party
 *     account token (never an OAuth app's), a verified account to mint, and a vault owned by the bearer's account
 *     (404 otherwise, the same answer as no such vault).
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
 * The write stamp (Parachute 0.9.1, as on the box): every key's name and kind are signed into it as a top-level `key`
 * claim (`{name, kind: "app"}`), so a 0.9 vault stamps its writes `via key:<name>` and its revisions with the kind.
 * With `on_behalf_of: true` the owner also lets the key write on behalf of people it names: the token carries
 * `permissions.acts_for: "<name>"` and a write may say who it is for, stamped `by <name>:<id>` (core `write-stamp.ts`).
 * The key's name is that prefix, so it must fit the prefix rule. Only the owner's own account token reaches this
 * route (`ownerGate`), so neither an app key nor an OAuth app can grant it, and OAuth consent never does. The grant is
 * stored on the key's registry row (`tokens.permissions`, the column the box uses), which is what the list reads.
 * A 0.8 vault worker refuses a token carrying `acts_for` (fail closed) rather than ignore it.
 *
 * Long-lived: one year by default and at most; `expires_in` (seconds) can shorten it.
 */
import { requireAccount, readJsonBody } from "./account-api.ts";
import { isUniqueViolation } from "./nostr-auth.ts";
import { composedVaultScope } from "@openparachute/door-contract";
import { ACCOUNT_TOKEN_AUDIENCE } from "./account-auth.ts";
import { ACCOUNT_TOKEN_CLIENT_ID } from "./account-token.ts";
import { jsonResponse, type OAuthDeps } from "./oauth-shared.ts";
import { signAccessToken, validateAccessToken } from "./tokens.ts";
import { getUserById } from "./users.ts";
import { callVaultApi } from "./vault-call.ts";
import { userOwnsVault } from "./vaults.ts";

export const APP_KEY_CLIENT_ID = "parachute-app-key";
export const APP_KEY_MAX_TTL_SECONDS = 365 * 24 * 60 * 60;
export const APP_KEY_MIN_TTL_SECONDS = 60;
export const APP_KEY_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const VAULT_NAME_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
const BODY_FIELDS = new Set(["name", "vault", "can", "expires_in", "on_behalf_of", "vaults", "types", "kind"]);
/** A type a key may be held to (core grants.ts): printable ASCII with no space, not `*`; at most 64 on one key. */
const TYPE_NAME_RE = /^[!-~]{1,128}$/;
const MAX_KEY_TYPES = 64;
const GRANT_VERBS_READ = ["read"];
const GRANT_VERBS_WRITE = ["read", "create", "update", "delete"];
/** A multi-vault key's `vault_name`: no vault can be called this (VAULT_NAME_RE), so no one-vault path matches it. */
export const MULTI_VAULT_KEY_VAULT = "*";
/** At most this many vaults in one key (a plan's vault cap is far below it; this only bounds the token's size). */
const MULTI_VAULT_MAX = 50;
/**
 * The on-behalf-of prefix rule, the twin of core `write-stamp.ts` (ON_BEHALF_PREFIX_RE, RESERVED_PREFIXES) and the
 * box's hub `keys.ts` onBehalfNameProblem: the key's name becomes the prefix of every "by" it stamps.
 */
const ON_BEHALF_PREFIX_RE = /^[a-z0-9.-]{1,64}$/;
const RESERVED_PREFIXES: readonly string[] = [
  "nostr", "key", "grant", "agent", "applet", "token", "operator", "migrate", "surface", "mcp", "api",
];
export function onBehalfNameProblem(name: string): string | null {
  if (!ON_BEHALF_PREFIX_RE.test(name)) {
    return `a key that writes on behalf of others is named for the prefix its writes carry ("by ${name}:<id>"), so its name is 1 to 64 lowercase letters, digits, '.' and '-': e.g. "fernhill-portal"`;
  }
  if (RESERVED_PREFIXES.includes(name)) return `"${name}" is reserved (${RESERVED_PREFIXES.join(", ")}); a key that writes on behalf of others needs another name`;
  return null;
}
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
  /** The registry row's permissions JSON (`{"acts_for": "<name>"}` on a key with the on-behalf-of grant). */
  permissions: string | null;
  /** A multi-vault key's `{vault: level}` JSON (migration 0032); null on a one-vault key. */
  vaults: string | null;
  /** The JSON list of types a one-vault key is held to (migration 0034, T-476); null: the whole vault. */
  types: string | null;
  /** 'agent' for a key made for an AI (migration 0034); null: an app. */
  kind: string | null;
}

export function typesOf(r: { types: string | null }): string[] | null {
  if (!r.types) return null;
  try {
    const t = JSON.parse(r.types) as unknown;
    return Array.isArray(t) && t.every((x) => typeof x === "string") ? (t as string[]) : null;
  } catch {
    return null;
  }
}

function vaultsOf(r: AppKeyRow): Record<string, "read" | "write"> | null {
  if (!r.vaults) return null;
  try {
    return JSON.parse(r.vaults) as Record<string, "read" | "write">;
  } catch {
    return null;
  }
}

function actsFor(permissions: string | null): string | null {
  if (!permissions) return null;
  try {
    const v = (JSON.parse(permissions) as { acts_for?: unknown }).acts_for;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

const err = (status: number, error: string, message: string) =>
  jsonResponse({ error, message }, status, { "cache-control": "no-store" });
const ok = (body: unknown, status = 200) => jsonResponse(body, status, { "cache-control": "no-store" });

function view(r: AppKeyRow, now: Date) {
  const status = r.revoked_at ? "revoked" : r.expires_at <= now.toISOString() ? "expired" : "active";
  const vaults = vaultsOf(r);
  return {
    name: r.name,
    // A multi-vault key shows its vaults and the level on each; a one-vault key keeps its shape exactly.
    ...(vaults ? { vaults } : { vault: r.vault_name, can: r.can }),
    status,
    created_at: r.created_at,
    expires_at: r.expires_at,
    last_used_at: r.last_used_at,
    revoked_at: r.revoked_at,
    // Present only on a key that may write on behalf of others, so every other key's shape is unchanged.
    ...(actsFor(r.permissions) !== null ? { on_behalf_of: true } : {}),
    // T-476: the types a key is held to, and `kind: "agent"` on a key made for an AI; absent otherwise.
    ...(typesOf(r) ? { types: typesOf(r) } : {}),
    ...(r.kind === "agent" ? { kind: "agent" } : {}),
  };
}

// The registry's revocation (vault delete, account delete, a family sweep) also ends an app key: read it live.
const ROWS_SQL = `SELECT a.name, a.jti, a.vault_name, a.can, a.created_at, a.expires_at, a.last_used_at,
         COALESCE(a.revoked_at, t.revoked_at) AS revoked_at, t.permissions, a.vaults, a.types, a.kind
    FROM app_keys a LEFT JOIN tokens t ON t.jti = a.jti
   WHERE a.user_id = ?`;

/**
 * The gate for every `/account/keys` route: `requireAccount(…, "admin")` AND the first-party account token
 * (`client_id=parachute-account`, minted by `/account/token` from a session or a NIP-98 sign-in). An OAuth app that
 * was granted `account:<id>:admin` must not mint year-long keys that outlive its own grant. Minting also needs a
 * verified account: a pre-claim holder of an unverified account must not leave keys behind.
 */
async function ownerGate(db: D1Database, req: Request, deps: OAuthDeps, opts: { mint?: boolean } = {}) {
  const auth = await requireAccount(db, req, deps, "admin");
  if (!auth.ok) return auth;
  if (auth.clientId !== ACCOUNT_TOKEN_CLIENT_ID) {
    return { ok: false as const, response: err(403, "insufficient_scope", "app keys are managed with your own account token, not an app's") };
  }
  if (opts.mint && !auth.user.emailVerified) {
    return { ok: false as const, response: err(403, "unverified_account", "verify your address before minting app keys") };
  }
  return auth;
}

export async function handleAccountKeyMint(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  // The owner, or (T-476) a vault's own admin credential, which makes keys for that vault alone (the app's Sharing
  // screen holds one): never for another vault, never several vaults, never on behalf of others.
  const vaultAdmin = await vaultAdminCredential(db, req, deps);
  const auth = vaultAdmin ? { ok: true as const, accountId: vaultAdmin.accountId } : await ownerGate(db, req, deps, { mint: true });
  if (!auth.ok) return withAnyOrigin(auth.response);
  return withAnyOrigin(await mintKey(db, req, deps, auth.accountId, vaultAdmin?.vault ?? null));
}

async function mintKey(db: D1Database, req: Request, deps: OAuthDeps, userId: string, adminOf: string | null): Promise<Response> {
  const body = await readJsonBody(req);
  const extra = Object.keys(body).filter((k) => !BODY_FIELDS.has(k));
  if (extra.length) {
    return err(400, "invalid_request", `unknown field(s): ${extra.join(", ")}; an app key takes name, vault, can, expires_in and on_behalf_of, or name, vaults and expires_in`);
  }
  const { name, vault, can, expires_in } = body;
  if (typeof name !== "string" || !APP_KEY_NAME_RE.test(name)) {
    return err(400, "invalid_name", "name: letters, digits, '.', '_' and '-', up to 80, starting with a letter or digit");
  }
  const kind = body.kind;
  if (kind !== undefined && kind !== "app" && kind !== "agent") {
    return err(400, "invalid_request", 'kind: "agent" for a key made for an AI, or "app" (the default)');
  }
  if (adminOf !== null && (body.vaults !== undefined || body.on_behalf_of !== undefined || vault !== adminOf)) {
    return err(403, "insufficient_scope", `this vault's admin credential makes keys for ${adminOf} alone, never on behalf of others; anything else is the owner's`);
  }
  if (body.vaults !== undefined) {
    if (body.types !== undefined) return err(400, "invalid_request", "types: a key held to some types reaches one vault (vault and can)");
    return mintMultiVaultKey(db, deps, userId, name, body);
  }
  if (typeof vault !== "string" || !VAULT_NAME_RE.test(vault)) {
    return err(400, "invalid_request", "vault: the name of one of your vaults");
  }
  if (can !== "read" && can !== "write") {
    return err(400, "invalid_scope", 'can: "read" or "write"; an app key is never admin');
  }
  const onBehalf = body.on_behalf_of;
  if (onBehalf !== undefined && typeof onBehalf !== "boolean") {
    return err(400, "invalid_request", 'on_behalf_of: true lets the key write on behalf of people it names (stamped "by <name>:<id>"); false or absent, it writes as you');
  }
  if (onBehalf === true) {
    const problem = onBehalfNameProblem(name);
    if (problem) return err(400, "invalid_name", problem);
  }
  // T-476 typed keys: the types this key may reach in its vault (core grants.ts holds the rules there).
  let types: string[] | null = null;
  if (body.types !== undefined) {
    const t = body.types;
    if (!Array.isArray(t) || t.length === 0 || t.length > MAX_KEY_TYPES || t.some((x) => typeof x !== "string" || !TYPE_NAME_RE.test(x) || x === "*")) {
      return err(400, "invalid_types", `types: 1 to ${MAX_KEY_TYPES} type names (printable, no spaces, not *); leave it out for a key that reaches the whole vault`);
    }
    if (onBehalf === true) return err(400, "invalid_request", "a key held to some types can't write on behalf of others");
    types = [...new Set(t as string[])];
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
  const permissions = onBehalf === true ? { acts_for: name } : null;
  const keyKind: "app" | "agent" = kind === "agent" ? "agent" : "app";
  const now = deps.now?.() ?? new Date();
  const signed = await signAccessToken(db, {
    sub: userId,
    scopes,
    audience: `vault.${vault}`,
    clientId: APP_KEY_CLIENT_ID,
    issuer: deps.issuer,
    vaultScope: [vault],
    // The key's name twice: `permissions.app_key` for a vault worker that reads only that (T-430), and the top-level
    // `key` claim the 0.9.1 engine reads (core write-stamp.ts parseKeyClaim, as the box mints it), with its kind. The
    // owner's on-behalf-of grant rides beside app_key in `permissions`. A typed key carries only its grant's id
    // (T-476): the vault reads the rules from its own table, and a vault that doesn't know `grant` refuses the key.
    permissions: { app_key: name, ...(permissions ?? {}), ...(types ? { grant: name } : {}) },
    ttlSeconds: ttl,
    now: () => now,
    key: { name, kind: keyKind },
  });
  const createdAt = now.toISOString();
  // A typed key's grant is filed at the vault before the key exists: the vault must hold the rules before anything
  // can present the key. A vault that can't keep it means no key.
  if (types) {
    const verbs = can === "write" ? GRANT_VERBS_WRITE : GRANT_VERBS_READ;
    const filed = await callGrant(db, deps, userId, vault, "PUT", name, { grantee: `key:${name}`, types: Object.fromEntries(types.map((t) => [t, verbs])), expires_at: signed.expiresAt });
    if (!filed || (filed.status !== 201 && filed.status !== 200)) {
      return err(502, "grant_not_filed", `the vault couldn't keep this key's grant (${filed ? filed.status : "unreachable"}); no key was made`);
    }
  }
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO tokens (jti, user_id, subject, client_id, scopes, expires_at, created_at, created_via, permissions)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'app_key', ?)`,
        )
        .bind(signed.jti, userId, name, APP_KEY_CLIENT_ID, scopes.join(" "), signed.expiresAt, createdAt, permissions ? JSON.stringify(permissions) : null),
      db
        .prepare(
          `INSERT INTO app_keys (user_id, name, jti, vault_name, can, kid, created_at, expires_at, types, kind)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(userId, name, signed.jti, vault, can, signed.kid, createdAt, signed.expiresAt, types ? JSON.stringify(types) : null, keyKind === "agent" ? "agent" : null),
    ]);
  } catch (e) {
    // A mint that doesn't finish ends the grant it filed (core #143): nothing may hold the rules for a key nobody has.
    if (types) await callGrant(db, deps, userId, vault, "DELETE", name);
    // The batch is one transaction: a racing mint of the same name lost the PRIMARY KEY, and nothing was written.
    // Any other failure is not about the name.
    if (isUniqueViolation(e)) return err(409, "name_taken", `a key called "${name}" already exists; pick another`);
    throw e;
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
    permissions: permissions ? JSON.stringify(permissions) : null,
    vaults: null,
    types: types ? JSON.stringify(types) : null,
    kind: keyKind === "agent" ? "agent" : null,
  };
  return ok({ ...view(row, now), scopes, token: signed.token }, 201);
}

/**
 * `POST /account/keys {name, vaults: {<vault>: "read"|"write"}, expires_in?}` — one key over several vaults, each at
 * its own level (0.9.1 "one multi-vault door", the box's mint shape). The token's audience is the account, so it opens
 * the account door (`/account/mcp`) and no vault directly; its scopes are `account:<id>:vaults:<v>:<level>`, which the
 * door reads at {@link keyLevelOnVault}. Never admin; every vault must be the owner's (404 otherwise, as for a
 * one-vault key); not with `vault`/`can`/`on_behalf_of`. Its `key` claim stamps the writes it makes through the door.
 */
async function mintMultiVaultKey(
  db: D1Database,
  deps: OAuthDeps,
  userId: string,
  name: string,
  body: Record<string, unknown>,
): Promise<Response> {
  if (body.vault !== undefined || body.can !== undefined || body.on_behalf_of !== undefined) {
    return err(400, "invalid_request", "a key takes either vault and can (one vault) or vaults (several), not both; on_behalf_of is for a one-vault key");
  }
  const keyKind: "app" | "agent" = body.kind === "agent" ? "agent" : "app";
  const raw = body.vaults;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return err(400, "invalid_request", 'vaults: {"<vault>": "read" | "write", ...}');
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0 || entries.length > MULTI_VAULT_MAX) {
    return err(400, "invalid_request", `vaults: one to ${MULTI_VAULT_MAX} of your vaults, each "read" or "write"`);
  }
  const levels: Record<string, "read" | "write"> = {};
  for (const [v, level] of entries) {
    if (!VAULT_NAME_RE.test(v)) return err(400, "invalid_request", `vaults: "${v}" is not a vault name`);
    if (level !== "read" && level !== "write") {
      return err(400, "invalid_scope", `vaults.${v}: "read" or "write"; a key is never admin`);
    }
    levels[v] = level;
  }
  let ttl = APP_KEY_MAX_TTL_SECONDS;
  const expires_in = body.expires_in;
  if (expires_in !== undefined) {
    if (typeof expires_in !== "number" || !Number.isInteger(expires_in) || expires_in < APP_KEY_MIN_TTL_SECONDS || expires_in > APP_KEY_MAX_TTL_SECONDS) {
      return err(400, "invalid_request", `expires_in: whole seconds, ${APP_KEY_MIN_TTL_SECONDS} to ${APP_KEY_MAX_TTL_SECONDS}`);
    }
    ttl = expires_in;
  }
  for (const v of Object.keys(levels)) {
    if (!(await userOwnsVault(db, userId, v))) return err(404, "vault_not_found", `you have no vault named "${v}"`);
  }
  const taken = await db.prepare("SELECT 1 AS x FROM app_keys WHERE user_id = ? AND name = ?").bind(userId, name).first<number>("x");
  if (taken !== null) {
    return err(409, "name_taken", `a key called "${name}" already exists (revoked keys keep their names); pick another`);
  }
  const scopes = Object.entries(levels).map(([v, level]) => composedVaultScope(userId, v, level));
  const can = Object.values(levels).includes("write") ? "write" : "read";
  const now = deps.now?.() ?? new Date();
  const signed = await signAccessToken(db, {
    sub: userId,
    scopes,
    audience: ACCOUNT_TOKEN_AUDIENCE,
    clientId: APP_KEY_CLIENT_ID,
    issuer: deps.issuer,
    vaultScope: [],
    ttlSeconds: ttl,
    now: () => now,
    key: { name, kind: keyKind },
  });
  const createdAt = now.toISOString();
  const vaultsJson = JSON.stringify(levels);
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO tokens (jti, user_id, subject, client_id, scopes, expires_at, created_at, created_via, permissions)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'app_key', NULL)`,
        )
        .bind(signed.jti, userId, name, APP_KEY_CLIENT_ID, scopes.join(" "), signed.expiresAt, createdAt),
      db
        .prepare(
          `INSERT INTO app_keys (user_id, name, jti, vault_name, can, kid, created_at, expires_at, vaults, kind)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(userId, name, signed.jti, MULTI_VAULT_KEY_VAULT, can, signed.kid, createdAt, signed.expiresAt, vaultsJson, keyKind === "agent" ? "agent" : null),
    ]);
  } catch (e) {
    if (isUniqueViolation(e)) return err(409, "name_taken", `a key called "${name}" already exists; pick another`);
    throw e;
  }
  const row: AppKeyRow = {
    name,
    jti: signed.jti,
    vault_name: MULTI_VAULT_KEY_VAULT,
    can,
    created_at: createdAt,
    expires_at: signed.expiresAt,
    last_used_at: null,
    revoked_at: null,
    permissions: null,
    vaults: vaultsJson,
    types: null,
    kind: keyKind === "agent" ? "agent" : null,
  };
  return ok({ ...view(row, now), scopes, token: signed.token }, 201);
}

/** Ask each vault holding a live key of this account when its keys were last used; keep the newest in D1. */
async function refreshLastUsed(db: D1Database, deps: OAuthDeps, userId: string, rows: AppKeyRow[], now: Date): Promise<void> {
  // A multi-vault key is spent at the account door, not at a vault, so no vault knows its last use.
  const live = rows.filter((r) => !r.vaults && !r.revoked_at && r.expires_at > now.toISOString());
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
  // The whole list is the owner's: a vault's admin credential reads that vault's list (vault-grants.ts) instead.
  if (await vaultAdminCredential(db, req, deps)) {
    return withAnyOrigin(err(403, "insufficient_scope", "the account's keys are the owner's; this vault's admin credential lists who reaches its vault at /account/vaults/<vault>/statements"));
  }
  const auth = await ownerGate(db, req, deps);
  if (!auth.ok) return withAnyOrigin(auth.response);
  const now = deps.now?.() ?? new Date();
  const res = await db.prepare(`${ROWS_SQL} ORDER BY a.created_at, a.name`).bind(auth.accountId).all<AppKeyRow>();
  const rows = res.results ?? [];
  await refreshLastUsed(db, deps, auth.accountId, rows, now);
  return withAnyOrigin(ok({ keys: rows.map((r) => view(r, now)) }));
}

export async function handleAccountKeyRevoke(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const auth = await ownerGate(db, req, deps);
  if (!auth.ok) return auth.response;
  const m = /^\/account\/keys\/([^/]+)\/?$/.exec(new URL(req.url).pathname);
  let name: string;
  try {
    name = decodeURIComponent(m?.[1] ?? "");
  } catch {
    return err(404, "key_not_found", "no such key");
  }
  const row = await appKeyRow(db, auth.accountId, name);
  if (!row) return err(404, "key_not_found", `you have no app key called "${name}"`);
  return ok(await revokeAppKey(db, deps, auth.accountId, row));
}

/** One of this account's app keys by name, with its live revocation state; null when it has none by that name. */
export async function appKeyRow(db: D1Database, userId: string, name: string): Promise<AppKeyRow | null> {
  return db.prepare(`${ROWS_SQL} AND a.name = ?`).bind(userId, name).first<AppKeyRow>();
}

/** Every one of this account's app keys. */
export async function appKeyRows(db: D1Database, userId: string): Promise<AppKeyRow[]> {
  return (await db.prepare(`${ROWS_SQL} ORDER BY a.created_at, a.name`).bind(userId).all<AppKeyRow>()).results ?? [];
}

/**
 * Revoke one app key (idempotent): the token row (the revocation list carries its jti), the key row, then the vault is
 * told directly so its very next request is refused (`refused_now`), and a typed key's grant is ended there too
 * (T-476), so the vault refuses it even reached some other way.
 */
export async function revokeAppKey(db: D1Database, deps: OAuthDeps, userId: string, row: AppKeyRow): Promise<{ name: string; revoked_at: string; refused_now: boolean }> {
  const name = row.name;
  const stamp = (deps.now?.() ?? new Date()).toISOString();
  // Push to the vault only while the key is unexpired and the vault is still this account's: a first-party call must
  // never wake a destroyed vault or reach a vault name another account has since taken (that vault never knew the
  // key; the revocation list covers the rest).
  // The push is idempotent, so a retried revoke (whose first push failed) pushes again.
  const unexpired = row.expires_at > stamp && row.vault_name !== MULTI_VAULT_KEY_VAULT;
  const stillOwned = unexpired && (await userOwnsVault(db, userId, row.vault_name));
  await db.batch([
    db.prepare("UPDATE tokens SET revoked_at = ? WHERE jti = ? AND revoked_at IS NULL").bind(stamp, row.jti),
    db.prepare("UPDATE app_keys SET revoked_at = ? WHERE jti = ? AND revoked_at IS NULL").bind(stamp, row.jti),
  ]);
  const after = await appKeyRow(db, userId, name);
  // Tell the vault now, so the next request is refused rather than the one after its revocation cache refreshes.
  // Nothing to tell when it expired or its vault is gone; otherwise refused_now is what the vault said.
  let refusedNow = !stillOwned;
  if (stillOwned) try {
    const res = await callVaultApi(db, deps, {
      userId,
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
  if (stillOwned && !refusedNow) console.warn(`event=app_key_revoke_push_failed vault=${row.vault_name}`);
  // A typed key's grant ends at the vault too: the token is already refused, and now the rules are gone.
  if (stillOwned && typesOf(row)) {
    const ended = await callGrant(db, deps, userId, row.vault_name, "DELETE", name);
    if (!ended || (ended.status !== 200 && ended.status !== 404)) console.warn(`event=app_key_grant_end_failed vault=${row.vault_name}`);
  }
  return { name, revoked_at: after?.revoked_at ?? stamp, refused_now: refusedNow };
}

/** File (PUT) or end (DELETE) a key's grant at its vault, with the first-party admin hop; null when unreachable. */
export async function callGrant(
  db: D1Database,
  deps: OAuthDeps,
  userId: string,
  vault: string,
  method: "PUT" | "DELETE",
  id: string,
  body?: unknown,
): Promise<Response | null> {
  try {
    const res = await callVaultApi(db, deps, {
      userId,
      vaultName: vault,
      method,
      apiPath: `/api/grants/${encodeURIComponent(id)}`,
      verb: "admin",
      ...(body === undefined ? {} : { jsonBody: body }),
      signal: AbortSignal.timeout(LAST_USED_TIMEOUT_MS * 2),
    });
    await res.clone().body?.cancel().catch(() => {});
    return res;
  } catch {
    return null;
  }
}

/** The clients whose vault admin credential may manage that vault's keys: Parachute's own (the account door's hop
 *  the owner mints, the app, the console), never an app that was granted admin over OAuth (it must not mint keys that
 *  outlive its own grant, the same rule `ownerGate` holds for the account). */
const VAULT_ADMIN_CLIENTS = new Set([ACCOUNT_TOKEN_CLIENT_ID, "parachute-app", "parachute-console"]);

/**
 * A vault's own admin credential (T-476, core vault-grants.ts ownerOrVaultAdmin): a token for one vault
 * (`aud=vault.<v>`) holding `vault:<v>:admin`, minted for one of Parachute's own clients, narrowed by nothing, whose
 * account still owns the vault. It manages that vault's keys: makes them (for that vault), lists who reaches it, and
 * ends what reaches it alone. Null for anything else (the caller then tries the owner's gate).
 */
export async function vaultAdminCredential(db: D1Database, req: Request, deps: OAuthDeps): Promise<{ accountId: string; vault: string } | null> {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
  if (!m) return null;
  let payload: Record<string, unknown>;
  try {
    payload = (await validateAccessToken(db, m[1]!, deps.issuer)).payload as Record<string, unknown>;
  } catch {
    return null;
  }
  const aud = Array.isArray(payload.aud) ? payload.aud[0] : payload.aud;
  if (typeof aud !== "string" || !aud.startsWith("vault.")) return null;
  const vault = aud.slice("vault.".length);
  const scopes = typeof payload.scope === "string" ? payload.scope.split(/\s+/) : [];
  if (!scopes.includes(`vault:${vault}:admin`)) return null;
  if (typeof payload.client_id !== "string" || !VAULT_ADMIN_CLIENTS.has(payload.client_id)) return null;
  // narrowed by nothing: any permission but the signer's pubkey (which only names who signed) counts as a narrowing
  const perms = payload.permissions;
  if (perms !== undefined && perms !== null && (typeof perms !== "object" || Array.isArray(perms) || Object.keys(perms).some((k) => k !== "principal_pubkey"))) return null;
  const sub = typeof payload.sub === "string" && payload.sub ? payload.sub : null;
  if (!sub) return null;
  const user = await getUserById(db, sub);
  if (!user || user.deletedAt !== null || user.suspendedAt !== null) return null;
  if (!(await userOwnsVault(db, sub, vault))) return null;
  return { accountId: sub, vault };
}

/** A bearer-only answer any origin may read (no credentials): the app calls these from its own origin (T-476). */
export function withAnyOrigin(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set("access-control-allow-origin", "*");
  headers.delete("access-control-allow-credentials");
  headers.append("vary", "Origin");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
