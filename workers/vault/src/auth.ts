/**
 * Cloud vault auth — a pure Identity-Worker resource server.
 *
 * Mirrors parachute-vault/src/auth.ts (authenticateVaultRequest) but validates
 * against the Identity Worker instead of the hub:
 *   - credential order: Bearer → X-API-Key → ?key= (auth.ts:287).
 *   - VAULT_AUTH_TOKEN operator bearer → admin (control-plane + test seam).
 *   - JWT → @openparachute/scope-guard against ISSUER_ORIGIN's JWKS, `aud`
 *     strict-pinned to `vault.<name>`, broad `vault:<verb>` scopes rejected,
 *     `vault_scope` per-user pin enforced, verb resolved read/write/admin.
 *
 * scope-guard is pure jose+fetch → Workers-compatible. JWKS + the revocation
 * list are fetched from ISSUER_ORIGIN (the Identity Worker serves both). The
 * per-isolate JWKS cache lives in scope-guard's module-global map; revocation
 * is fail-closed with a last-good cache. Cross-isolate Cache-API seeding of
 * those caches (design §5 cold-isolate caveat) is a deferred hardening.
 */
import {
  createScopeGuard,
  enforceVaultScope,
  looksLikeJwt,
  HubJwtError,
  type HubJwtClaims,
  type JwksGetter,
} from "@openparachute/scope-guard";
import { createLocalJWKSet, decodeJwt } from "jose";
import type { Env } from "./env.js";

export const SCOPE_READ = "vault:read";
export const SCOPE_WRITE = "vault:write";
export const SCOPE_ADMIN = "vault:admin";

/**
 * The `client_id` claim the Identity Worker mints on ITS OWN first-party
 * tokens (workers/identity/src/vault-call.ts FIRST_PARTY_CLIENT_ID — keep the
 * two constants identical). Load-bearing for the internal config seam
 * (vault-do.ts handleInternalConfig): a vault OWNER can legitimately mint
 * `vault:<name>:admin` through the public OAuth flow, so scope alone can't
 * distinguish platform from tenant — but DCR client ids are server-generated
 * UUIDs, so no OAuth client can ever carry this id. Only the issuer's
 * internal mint (and the VAULT_AUTH_TOKEN operator bearer) may touch
 * platform-owned config like the plan storage cap.
 */
export const FIRST_PARTY_CLIENT_ID = "parachute-console";

export type VaultVerb = "read" | "write" | "admin";
const VERB_RANK: Record<VaultVerb, number> = { read: 0, write: 1, admin: 2 };

export interface AuthResult {
  /**
   * COARSE two-level summary (bun token-store back-compat shape): "full" =
   * the token can write, "read" = read-only. It deliberately collapses
   * write and admin — NEVER use it to authorize an admin-tier operation
   * (that collapse was the cloud#134 A.1 gap). Admin gating goes through
   * `hasScopeForVault(auth.scopes, vaultName, "admin")` on the real scope
   * list, which preserves the read < write < admin ladder.
   */
  permission: "full" | "read";
  scopes: string[];
  /** null = unscoped (the only shape cloud v1 issues). */
  scoped_tags: string[] | null;
  actor: string | null;
  via: string | null;
  /**
   * The validated JWT's `client_id` claim (null for the operator bearer or a
   * token without one). The internal config seam gates on
   * {@link FIRST_PARTY_CLIENT_ID}; everything else ignores it.
   */
  clientId: string | null;
  /**
   * The JWT's `exp` (epoch SECONDS), or null for the operator bearer / a token
   * with no exp. Surfaced so the WS live-query binding can sweep-close a socket
   * whose token has expired (a hibernatable socket carries no standing timer, so
   * expiry is enforced on the next DO wake — see `docs/live-query-ws.md`).
   */
  exp: number | null;
  /**
   * The JWT's `jti`, or null (operator bearer / no jti). Surfaced so the WS
   * sweep can check an already-authed socket's token against the revocation list
   * (auth-time validation already fail-closes on revocation; this catches a
   * revocation that lands AFTER the socket authed).
   */
  jti: string | null;
}

/**
 * Result of authenticating a raw token (the transport-agnostic core of
 * {@link authenticateVaultRequest}). The WS binding maps a failure onto a close
 * code (unauthorized → 4401, vault_scope_mismatch → 4403); the request path
 * maps it onto the exact 401/403 response bodies (below).
 */
export type TokenAuthResult =
  | { ok: true; auth: AuthResult }
  | { ok: false; reason: "unauthorized"; message: string }
  | { ok: false; reason: "vault_scope_mismatch"; vaultScope: string[] };

function isVerb(s: string): s is VaultVerb {
  return s === "read" || s === "write" || s === "admin";
}

function decompose(scope: string): { vault: string | null; verb: VaultVerb } | null {
  const parts = scope.split(":");
  if (parts.length === 2 && parts[0] === "vault" && isVerb(parts[1]!)) {
    return { vault: null, verb: parts[1]! as VaultVerb };
  }
  if (parts.length === 3 && parts[0] === "vault" && parts[1]!.length > 0 && isVerb(parts[2]!)) {
    return { vault: parts[1]!, verb: parts[2]! as VaultVerb };
  }
  return null;
}

/** Ported from scopes.ts:hasScopeForVault. */
export function hasScopeForVault(granted: string[], vaultName: string, verb: VaultVerb): boolean {
  const reqRank = VERB_RANK[verb];
  for (const s of granted) {
    const d = decompose(s);
    if (!d) continue;
    if (d.vault !== null && d.vault !== vaultName) continue;
    if (VERB_RANK[d.verb] >= reqRank) return true;
  }
  return false;
}

/** Ported from scopes.ts:findBroadVaultScopes. */
function findBroadVaultScopes(granted: string[]): string[] {
  return granted.filter((s) => {
    const d = decompose(s);
    return d && d.vault === null;
  });
}

/**
 * Distinct vault names NAMED by narrowed `vault:<name>:<verb>` scopes in the
 * granted list. Broad `vault:<verb>` scopes name no vault (a legacy/operator
 * shape) and are skipped. Used by {@link deriveVaultFromToken} for the canonical
 * root `/mcp` endpoint (U1) — one of three agreeing sources (scope / `aud` /
 * single-element `vault_scope`) the derivation cross-checks. A cloud token
 * carries scopes for exactly one vault, so this returns a single-element list in
 * practice; a length ≠ 1 signals a malformed/multi-vault scope set the
 * derivation treats as a disagreement. Mirrors parachute-vault/src/scopes.ts's
 * `narrowedVaultNames`.
 */
export function narrowedVaultNames(granted: string[]): string[] {
  const names = new Set<string>();
  for (const s of granted) {
    const d = decompose(s);
    if (d && d.vault !== null) names.add(d.vault);
  }
  return [...names];
}

/** Ported from scopes.ts:verbForMethod. */
export function verbForMethod(method: string): VaultVerb {
  const m = method.toUpperCase();
  return m === "GET" || m === "HEAD" || m === "OPTIONS" ? "read" : "write";
}

/**
 * ADMIN-ONLY REST operations — the tag-schema/taxonomy mutation carve-out,
 * ported verbatim from parachute-vault/src/routing.ts `isTagSchemaMutation`
 * (the vault 0.7.1 write/admin re-tier). These operations define a tag's
 * SCHEMA or restructure the tag graph across every note carrying it —
 * structure, not content — the same distinction that keeps create-note/
 * update-note/delete-note at `write` while moving these to `admin`.
 *
 * The list is an EXPLICIT enumeration (no default-allow-into-admin): exactly
 * these four operations require `vault:admin`; everything else keeps the
 * generic verbForMethod tier. `apiPath` is the path after `/api` (the DO
 * dispatcher's `apiPath`), matching bun's `apiSubpath` shape:
 *
 *   - PUT    /tags/:name          (update-tag)
 *   - DELETE /tags/:name          (delete-tag)
 *   - POST   /tags/merge          (merge-tags)
 *   - POST   /tags/:name/rename   (rename-tag)
 *
 * Deliberately does NOT match POST /tags/:name/conformance (2 path segments,
 * not 1 — a read-only preview, see bun's `isReadOnlyPost`) or plain
 * GET /tags[/:name] (read, unaffected). Before this carve-out, cloud REST
 * gated these at the collapsed write tier ("permission: full"), so a
 * `vault:<name>:write` token could mutate tag schemas — the exact gap
 * vault PR #580 closed on the self-hosted door (cloud#134 item A.1).
 */
export function isTagSchemaMutation(method: string, apiPath: string): boolean {
  const m = method.toUpperCase();
  return (
    ((m === "PUT" || m === "DELETE") && /^\/tags\/[^/]+$/.test(apiPath)) ||
    (m === "POST" && (apiPath === "/tags/merge" || /^\/tags\/[^/]+\/rename$/.test(apiPath)))
  );
}

/**
 * ADMIN-ONLY REST operation — seed-pack application (POST /packs/:name).
 * Found by adversarial review of cloud#134 A.1: `handleApplyPack` (vault-do.ts)
 * reaches core's `applySeedPack` → `upsertTagRecord(name, {fields,
 * parent_names, description})` for every tag a pack declares — the EXACT
 * mutation `PUT /api/tags/:name` requires `vault:admin` for via
 * {@link isTagSchemaMutation} above. Before this, a pack route dispatched
 * after the generic write/admin gate at plain `write`, so a write-tier token
 * could `POST /api/packs/<any-pack-with-a-tag>` and silently overwrite an
 * owner's curated tag schema — the tag-schema carve-out closed the front door
 * (`PUT /tags/:name`) but left this side door open. `apiPath` is the path
 * after `/api` (the DO dispatcher's `apiPath`, matching {@link isTagSchemaMutation}'s
 * convention) — anything under `/packs/` is a pack-apply; the pack name itself
 * (single path segment, URI-decoded by `handleApplyPack`) doesn't matter here.
 */
export function isPackApply(method: string, apiPath: string): boolean {
  return method.toUpperCase() === "POST" && apiPath.startsWith("/packs/");
}

// RFC 7235: the auth-scheme token is case-insensitive (`Bearer`/`bearer`/
// `BEARER`, ...) — only the scheme is matched case-insensitively, the token
// itself is passed through verbatim. Mirrors parachute-vault/src/auth.ts's
// BEARER_PREFIX (V1.4/C1.3 contracts-brief parity).
const BEARER_PREFIX = /^Bearer\s+/i;

/** Bearer → X-API-Key → ?key= (parachute-vault/src/auth.ts:287). */
export function extractApiKey(req: Request): string | null {
  const authHeader = req.headers.get("authorization");
  if (authHeader && BEARER_PREFIX.test(authHeader)) return authHeader.replace(BEARER_PREFIX, "");
  const xApiKey = req.headers.get("x-api-key");
  if (xApiKey) return xApiKey;
  return new URL(req.url).searchParams.get("key");
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Parse the ADDITIVE `ALLOWED_ISSUERS` set (comma-separated origins) into a
 * normalized array — trailing slashes stripped (matching `hubOrigin`'s own
 * normalization), blanks dropped. Returns `undefined` when unset/empty so the
 * guard is built WITHOUT the `allowedIssuers` option, byte-identical to the
 * single-ISSUER_ORIGIN behavior that predated this seam.
 */
function parseAllowedIssuers(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const set = raw
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter((s) => s.length > 0);
  return set.length > 0 ? set : undefined;
}

// One guard per isolate, keyed by (issuer, test-jwks, allowed-issuer-set).
// scope-guard's JWKS cache is module-global, so reuse maximizes cache hits
// across requests in a warm isolate. A deployed isolate serves one fixed env, so
// the allowed-set component is constant in production; folding it into the key
// keeps the cache correct if the set ever varies (and lets the auth-matrix tests
// exercise distinct sets within one isolate).
let cachedGuard: { key: string; guard: ReturnType<typeof createScopeGuard> } | undefined;

function getGuard(env: Env) {
  const issuer = (env.ISSUER_ORIGIN ?? "").replace(/\/$/, "");
  // TEST_JWKS is honored ONLY under ENVIRONMENT="test". Gating on presence alone
  // would make a stray production var a silent auth bypass (the private key is
  // in git) — so a prod deploy that never sets ENVIRONMENT ignores TEST_JWKS and
  // always fetches real keys from ISSUER_ORIGIN.
  const testMode = !!env.TEST_JWKS && env.ENVIRONMENT === "test";
  // ADDITIVE iss set (P0.1). scope-guard unions this with `hubOrigin`; the
  // signature verify runs FIRST regardless of `iss` (validate.ts), so a wider
  // set never weakens the gate — a foreign-key token 401s no matter its `iss`.
  // When undefined, the `allowedIssuers` option is omitted entirely below, so
  // the createScopeGuard call is identical to before this var existed.
  const allowedExtra = parseAllowedIssuers(env.ALLOWED_ISSUERS);
  const key = `${issuer}::${testMode ? "test" : "prod"}::${allowedExtra?.join(",") ?? ""}`;
  if (cachedGuard && cachedGuard.key === key) return cachedGuard.guard;
  // Re-evaluated per validate by scope-guard; the isolate's env is fixed so the
  // captured array is stable (and the cache key above tracks it if it isn't).
  const allowedIssuers = allowedExtra ? { allowedIssuers: () => allowedExtra } : {};
  const guard = testMode
    ? createScopeGuard({
        hubOrigin: issuer,
        ...allowedIssuers,
        // Static key set + empty revocation list — the auth matrix runs without
        // a live Identity Worker. createLocalJWKSet lacks jose's remote `.reload`
        // escape hatch; scope-guard's forced-reload no-ops when it's absent.
        jwksGetter: createLocalJWKSet(JSON.parse(env.TEST_JWKS!)) as unknown as JwksGetter,
        revocationFetcher: async () => ({ generated_at: new Date().toISOString(), jtis: [] }),
      })
    : createScopeGuard({ hubOrigin: issuer, jwksOrigin: issuer, ...allowedIssuers });
  cachedGuard = { key, guard };
  return guard;
}

function unauthorized(message: string): { error: Response } {
  return { error: Response.json({ error: "Unauthorized", message }, { status: 401 }) };
}

/**
 * Authenticate a RAW token against `vaultName` (Bearer/X-API-Key/?key= value,
 * or a WS first-message auth token). Transport-agnostic: the request path
 * ({@link authenticateVaultRequest}) and the WS binding both call this and map
 * the result onto their own error surface. Never touches the `Request` — a
 * WebSocket first-message auth has no header to read.
 */
export async function authenticateVaultToken(
  token: string,
  env: Env,
  vaultName: string,
): Promise<TokenAuthResult> {
  // Server-wide operator bearer (mirrors VAULT_AUTH_TOKEN). No exp — the sweep
  // treats a null-exp socket as non-expiring (control-plane / test seam).
  const operator = env.VAULT_AUTH_TOKEN?.trim();
  if (operator && operator.length > 0 && constantTimeEquals(token, operator)) {
    return {
      ok: true,
      auth: {
        permission: "full",
        scopes: [SCOPE_ADMIN, SCOPE_WRITE, SCOPE_READ],
        scoped_tags: null,
        actor: "operator",
        via: "operator",
        clientId: null,
        exp: null,
        jti: null,
      },
    };
  }

  if (!looksLikeJwt(token)) return { ok: false, reason: "unauthorized", message: "Invalid API key" };

  let claims: HubJwtClaims;
  try {
    claims = await getGuard(env).validateHubJwt(token, { expectedAudience: `vault.${vaultName}` });
  } catch (err) {
    if (err instanceof HubJwtError) {
      if (err.code === "revoked") return { ok: false, reason: "unauthorized", message: "token has been revoked" };
      if (err.code === "revocation_unavailable") {
        return { ok: false, reason: "unauthorized", message: "token cannot be validated: revocation list unavailable" };
      }
      return { ok: false, reason: "unauthorized", message: err.message };
    }
    return { ok: false, reason: "unauthorized", message: err instanceof Error ? err.message : "JWT validation failed" };
  }

  const broad = findBroadVaultScopes(claims.scopes);
  if (broad.length > 0) {
    return {
      ok: false,
      reason: "unauthorized",
      message: `token carries broad vault scope(s): ${broad.join(" ")}. Cloud tokens must use resource-narrowed scopes (vault:<name>:<verb>).`,
    };
  }

  // Per-user vault pin (defense in depth after the audience strict-check).
  if (!enforceVaultScope(claims, vaultName)) {
    return { ok: false, reason: "vault_scope_mismatch", vaultScope: claims.vaultScope };
  }

  const permission: "full" | "read" =
    hasScopeForVault(claims.scopes, vaultName, "write") ? "full" : "read";

  // The signature is already verified (validateHubJwt above); decoding the
  // payload for `exp` is safe. `jti` is surfaced by scope-guard's claims.
  let exp: number | null = null;
  try {
    const payload = decodeJwt(token);
    exp = typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    exp = null;
  }

  return {
    ok: true,
    auth: {
      permission,
      scopes: claims.scopes,
      scoped_tags: null,
      actor: claims.sub && claims.sub.length > 0 ? claims.sub : null,
      via: "api",
      clientId: claims.clientId ?? null,
      exp,
      jti: claims.jti ?? null,
    },
  };
}

/**
 * Authenticate a request against `vaultName`. Returns an AuthResult or a
 * `{ error: Response }` shaped exactly like the bun vault's. A thin wrapper over
 * {@link authenticateVaultToken} — the credential-order extraction plus the
 * failure → response mapping (byte-identical bodies to before the WS-binding
 * refactor).
 */
export async function authenticateVaultRequest(
  req: Request,
  env: Env,
  vaultName: string,
): Promise<{ error: Response } | AuthResult> {
  const key = extractApiKey(req);
  if (!key) return unauthorized("API key required");

  const result = await authenticateVaultToken(key, env, vaultName);
  if (result.ok) return result.auth;

  if (result.reason === "vault_scope_mismatch") {
    return {
      error: Response.json(
        {
          error: "Forbidden",
          error_type: "vault_scope_mismatch",
          message: `token's vault_scope (${result.vaultScope.join(", ")}) does not include the requested vault '${vaultName}'`,
          required_vault: vaultName,
        },
        { status: 403 },
      ),
    };
  }
  return unauthorized(result.message);
}

/**
 * The highest verb a scope set grants for `vaultName` (VERB_RANK, or -1 for
 * none). Used by the WS binding's re-auth check: a token refresh on an open
 * socket may narrow-or-equal the granted verb, never widen it.
 */
export function vaultVerbRank(scopes: string[], vaultName: string): number {
  if (hasScopeForVault(scopes, vaultName, "admin")) return VERB_RANK.admin;
  if (hasScopeForVault(scopes, vaultName, "write")) return VERB_RANK.write;
  if (hasScopeForVault(scopes, vaultName, "read")) return VERB_RANK.read;
  return -1;
}

/** Insufficient-scope 403 envelope (parachute-vault HTTP_API.md). */
export function insufficientScope(requiredVerb: VaultVerb, vaultName: string, granted: string[]): Response {
  const broad = `vault:${requiredVerb}`;
  return Response.json(
    {
      error: "Forbidden",
      error_type: "insufficient_scope",
      message: `This endpoint requires the '${broad}' scope (or 'vault:${vaultName}:${requiredVerb}').`,
      required_scope: broad,
      granted_scopes: granted,
    },
    { status: 403 },
  );
}

/**
 * Outcome of deriving a target vault from a request's bearer at the canonical
 * root `/mcp` endpoint (U1). `vaultName` on success; a coarse `error` otherwise.
 * Both failure reasons collapse to the SAME 401 + root-PRM challenge at the edge
 * router — the distinction is for logging/tests, never leaked to the client.
 * `no_bearer` = no credential presented; `not_derivable` = a credential that
 * names no single vault (non-JWT operator/legacy bearer, invalid / expired /
 * revoked JWT, or a JWT whose scope / `aud` / `vault_scope` sources name zero or
 * conflicting vaults). Mirrors parachute-vault/src/auth.ts's `VaultDerivation`.
 */
export type VaultDerivation = { vaultName: string } | { error: "no_bearer" | "not_derivable" };

/**
 * Derive the target vault from a request's bearer WITHOUT authorizing the
 * request. The edge router re-dispatches the derived name through the full
 * per-vault DO, which re-validates the token WITH the audience pin
 * (`vault.<name>`) — so a bad derivation FAILS the inner check rather than
 * bypassing it (derive-then-redispatch, defense in depth). This function only
 * reads the claims well enough to name the vault; it is never the gate.
 *
 * The JWT is validated with the SAME scope-guard trust kernel the DO's own auth
 * uses (signature, `iss` pin, `jti` + revocation, expiry) but WITHOUT
 * `expectedAudience` — at the root we don't yet know which audience to expect;
 * that pin is re-applied by the re-dispatch. Non-JWT credentials (the operator
 * `VAULT_AUTH_TOKEN`) name no vault → `not_derivable`; they keep working at the
 * URL-addressed `/vault/<name>/*` surface.
 *
 * Three independent sources can name a vault: a narrowed `vault:<name>:<verb>`
 * scope, an `aud` of the form `vault.<name>`, and a single-element `vault_scope`
 * claim. On an issuer-minted token these AGREE. We collect every name any source
 * provides and require EXACTLY ONE distinct name: zero (nothing named a vault)
 * and two-or-more (the sources disagree) both fail closed with `not_derivable`.
 * We never pick a winner from a precedence order. Mirrors
 * parachute-vault/src/auth.ts's `deriveVaultFromToken`.
 */
export async function deriveVaultFromToken(req: Request, env: Env): Promise<VaultDerivation> {
  const key = extractApiKey(req);
  if (!key) return { error: "no_bearer" };
  if (!looksLikeJwt(key)) return { error: "not_derivable" };
  let claims: HubJwtClaims;
  try {
    // No `expectedAudience`: the DO's trust kernel minus the aud pin (which the
    // re-dispatch re-applies). A bad signature / iss / expiry / revoked jti
    // throws here → not_derivable → the standard 401 root challenge.
    claims = await getGuard(env).validateHubJwt(key, {});
  } catch {
    return { error: "not_derivable" };
  }
  const named = new Set<string>();
  for (const name of narrowedVaultNames(claims.scopes)) named.add(name);
  const audMatch = claims.aud?.match(/^vault\.(.+)$/);
  if (audMatch) named.add(audMatch[1]!);
  if (claims.vaultScope.length === 1) named.add(claims.vaultScope[0]!);
  if (named.size !== 1) return { error: "not_derivable" };
  return { vaultName: [...named][0]! };
}
