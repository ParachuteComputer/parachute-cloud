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
import { createLocalJWKSet } from "jose";
import type { Env } from "./env.js";

export const SCOPE_READ = "vault:read";
export const SCOPE_WRITE = "vault:write";
export const SCOPE_ADMIN = "vault:admin";

export type VaultVerb = "read" | "write" | "admin";
const VERB_RANK: Record<VaultVerb, number> = { read: 0, write: 1, admin: 2 };

export interface AuthResult {
  permission: "full" | "read";
  scopes: string[];
  /** null = unscoped (the only shape cloud v1 issues). */
  scoped_tags: string[] | null;
  actor: string | null;
  via: string | null;
}

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

/** Ported from scopes.ts:verbForMethod. */
export function verbForMethod(method: string): VaultVerb {
  const m = method.toUpperCase();
  return m === "GET" || m === "HEAD" || m === "OPTIONS" ? "read" : "write";
}

/** Bearer → X-API-Key → ?key= (parachute-vault/src/auth.ts:287). */
export function extractApiKey(req: Request): string | null {
  const authHeader = req.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);
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

// One guard per isolate, keyed by (issuer, test-jwks). scope-guard's JWKS cache
// is module-global, so reuse maximizes cache hits across requests in a warm
// isolate.
let cachedGuard: { key: string; guard: ReturnType<typeof createScopeGuard> } | undefined;

function getGuard(env: Env) {
  const issuer = (env.ISSUER_ORIGIN ?? "").replace(/\/$/, "");
  // TEST_JWKS is honored ONLY under ENVIRONMENT="test". Gating on presence alone
  // would make a stray production var a silent auth bypass (the private key is
  // in git) — so a prod deploy that never sets ENVIRONMENT ignores TEST_JWKS and
  // always fetches real keys from ISSUER_ORIGIN.
  const testMode = !!env.TEST_JWKS && env.ENVIRONMENT === "test";
  const key = `${issuer}::${testMode ? "test" : "prod"}`;
  if (cachedGuard && cachedGuard.key === key) return cachedGuard.guard;
  const guard = testMode
    ? createScopeGuard({
        hubOrigin: issuer,
        // Static key set + empty revocation list — the auth matrix runs without
        // a live Identity Worker. createLocalJWKSet lacks jose's remote `.reload`
        // escape hatch; scope-guard's forced-reload no-ops when it's absent.
        jwksGetter: createLocalJWKSet(JSON.parse(env.TEST_JWKS!)) as unknown as JwksGetter,
        revocationFetcher: async () => ({ generated_at: new Date().toISOString(), jtis: [] }),
      })
    : createScopeGuard({ hubOrigin: issuer, jwksOrigin: issuer });
  cachedGuard = { key, guard };
  return guard;
}

function unauthorized(message: string): { error: Response } {
  return { error: Response.json({ error: "Unauthorized", message }, { status: 401 }) };
}

/**
 * Authenticate a request against `vaultName`. Returns an AuthResult or a
 * `{ error: Response }` shaped exactly like the bun vault's.
 */
export async function authenticateVaultRequest(
  req: Request,
  env: Env,
  vaultName: string,
): Promise<{ error: Response } | AuthResult> {
  const key = extractApiKey(req);
  if (!key) return unauthorized("API key required");

  // Server-wide operator bearer (mirrors VAULT_AUTH_TOKEN).
  const operator = env.VAULT_AUTH_TOKEN?.trim();
  if (operator && operator.length > 0 && constantTimeEquals(key, operator)) {
    return {
      permission: "full",
      scopes: [SCOPE_ADMIN, SCOPE_WRITE, SCOPE_READ],
      scoped_tags: null,
      actor: "operator",
      via: "operator",
    };
  }

  if (!looksLikeJwt(key)) return unauthorized("Invalid API key");

  let claims: HubJwtClaims;
  try {
    claims = await getGuard(env).validateHubJwt(key, { expectedAudience: `vault.${vaultName}` });
  } catch (err) {
    if (err instanceof HubJwtError) {
      if (err.code === "revoked") return unauthorized("token has been revoked");
      if (err.code === "revocation_unavailable") {
        return unauthorized("token cannot be validated: revocation list unavailable");
      }
      return unauthorized(err.message);
    }
    return unauthorized(err instanceof Error ? err.message : "JWT validation failed");
  }

  const broad = findBroadVaultScopes(claims.scopes);
  if (broad.length > 0) {
    return unauthorized(
      `token carries broad vault scope(s): ${broad.join(" ")}. Cloud tokens must use resource-narrowed scopes (vault:<name>:<verb>).`,
    );
  }

  // Per-user vault pin (defense in depth after the audience strict-check).
  if (!enforceVaultScope(claims, vaultName)) {
    return {
      error: Response.json(
        {
          error: "Forbidden",
          error_type: "vault_scope_mismatch",
          message: `token's vault_scope (${claims.vaultScope.join(", ")}) does not include the requested vault '${vaultName}'`,
          required_vault: vaultName,
        },
        { status: 403 },
      ),
    };
  }

  const permission: "full" | "read" =
    hasScopeForVault(claims.scopes, vaultName, "write") ? "full" : "read";

  return {
    permission,
    scopes: claims.scopes,
    scoped_tags: null,
    actor: claims.sub && claims.sub.length > 0 ? claims.sub : null,
    via: "api",
  };
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
