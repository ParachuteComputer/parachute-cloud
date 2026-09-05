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
  /**
   * null = unscoped, and in cloud today that is the ONLY value that ever
   * reaches a handler: `authenticateVaultToken` parses
   * `permissions.scoped_tags` for real (cloud#278) but REFUSES any token that
   * carries one, because the runtime has no enforcement seam (`rest/tag-scope.ts`
   * is a stub and nothing reads this field). Typed `string[] | null` so the
   * refusal can be lifted without a type change once tag scope is enforced.
   */
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

/** NIP-01 pubkey shape: 32 bytes, lowercase hex. */
const NOSTR_PUBKEY_RE = /^[0-9a-f]{64}$/;

/**
 * Write-attribution `via` label for a NIP-98-signed principal.
 *
 * `nostr:<64-hex>` joins the open-ended `via` vocabulary (`mcp` ·
 * `surface:<name>` · `agent:<id>` · `operator` · `api`) with the same
 * `<class>:<id>` shape as `agent:<id>`, so `created_via` / `last_updated_via`
 * stay plain exact-match strings.
 */
export function nostrVia(pubkey: string): string {
  return `nostr:${pubkey}`;
}

/**
 * Read the signing pubkey out of a validated hub JWT's `permissions` claim.
 *
 * Wire contract: `permissions: { principal_pubkey: "<64 lowercase hex>" }`,
 * stamped ONLY on tokens minted for a NIP-98-authenticated caller. Full
 * contract: parachute-vault `docs/contracts/nostr-principal-attribution.md`.
 *
 * DOOR PARITY (cloud#277): this is a byte-for-byte port of the bun vault's
 * `src/auth.ts`. `@openparachute/core` is shared verbatim between the two
 * doors (`package.json` `file:../../../parachute-vault/core`), so core's
 * `query-notes` manifest advertises `created_via = nostr:<hex>` to cloud
 * clients too. Without this, cloud would advertise a filter value it could
 * never produce.
 *
 * Why it rides inside `permissions`: `@openparachute/scope-guard` returns a
 * FIXED claim surface and drops every other claim; `permissions` is its
 * documented verbatim passthrough.
 *
 * FAIL-SOFT: a missing / malformed / wrong-case / non-hex value returns null
 * and the caller falls back to the generic credential class. Attribution is a
 * label, not an access decision — the opposite of a `scoped_tags` misread,
 * which must fail closed.
 */
export function parsePrincipalPubkey(
  permissions: Record<string, unknown> | undefined,
): string | null {
  if (!permissions) return null;
  if (!("principal_pubkey" in permissions)) return null;
  const raw = permissions.principal_pubkey;
  if (typeof raw === "string" && NOSTR_PUBKEY_RE.test(raw)) return raw;
  // PRESENT but unreadable. Fail soft (see above) — but never SILENTLY: the
  // symptom of a dropped claim (`created_via` back to `mcp`) is byte-identical
  // to the symptom of the hub never having stamped it, which is the very bug
  // this feature exists to fix. One warn per distinct bad value keeps the two
  // distinguishable in the worker log. A pubkey is public by construction, so
  // logging the value leaks nothing. Parity with the bun door.
  const seen = typeof raw === "string" ? raw : `<${typeof raw}>`;
  if (!warnedBadPubkeys.has(seen)) {
    warnedBadPubkeys.add(seen);
    console.warn(
      "[attribution] hub JWT permissions.principal_pubkey present but not 64 lowercase hex — " +
        `ignoring, falling back to the generic credential class (saw: ${JSON.stringify(seen)})`,
    );
  }
  return null;
}

/** Dedupe key set for the warn above — bounded in practice by the number of
 *  DISTINCT malformed values a misconfigured issuer emits (one). */
const warnedBadPubkeys = new Set<string>();

/** A present-but-unreadable `permissions.scoped_tags`. Caller REJECTS (401). */
export class MalformedScopedTagsError extends Error {
  override name = "MalformedScopedTagsError";
}

/**
 * Read the tag-scope allowlist out of a validated JWT's `permissions` claim
 * (cloud#278, second half). Port of the bun vault's
 * `parseScopedTagsFromPermissions` (`parachute-vault/src/auth.ts`), with the
 * same three outcomes and the same strict FAIL-CLOSED invariant — tag-scoping
 * is always a RESTRICTION, so a misread must NEVER widen access:
 *
 *   1. Claim absent (no `permissions`, or no `scoped_tags` key), or explicitly
 *      `null`/`undefined` → `null` = UNSCOPED = full vault. This is today's
 *      shape for every cloud-issued token (`workers/identity/src/tokens.ts`
 *      signs no `permissions` at all), so this is the byte-identical path.
 *   2. A non-empty array of non-empty strings → that array. The token IS
 *      tag-scoped.
 *   3. Present but MALFORMED — a string, number, object, an array holding a
 *      non-string / empty string, or the empty array `[]` → throws. We do NOT
 *      coerce: `null` would widen a token meant to be scoped up to full vault,
 *      and `[]` is read as "unscoped" by the enforcement helpers in
 *      `rest/tag-scope.ts`, so it would widen too.
 *
 * DELIBERATELY the opposite of {@link parsePrincipalPubkey}, which fails SOFT:
 * that claim only labels a write, this one bounds what a token may see.
 */
export function parseScopedTagsFromPermissions(
  permissions: Record<string, unknown> | undefined,
): string[] | null {
  if (!permissions || !("scoped_tags" in permissions)) return null;
  const raw = permissions.scoped_tags;
  if (raw === null || raw === undefined) return null; // explicit "unscoped"
  if (
    Array.isArray(raw) &&
    raw.length > 0 &&
    raw.every((t) => typeof t === "string" && t.length > 0)
  ) {
    return raw as string[];
  }
  // Present but malformed (incl. `[]`): fail closed — never widen.
  throw new MalformedScopedTagsError(
    "JWT permissions.scoped_tags is present but not a non-empty array of tag names",
  );
}

/**
 * Refine the credential-class `via` for a write that arrived on the MCP
 * channel. `mcp` wins over the generic classes, but NOT over a class that
 * already names a principal or channel of its own:
 *
 *   - `operator` — the operator bearer's credential class IS its channel.
 *   - `nostr:<pubkey>` — the NIP-98 signer. Every caller through the hub's
 *     `/mcp` door is on the `mcp` channel, so `mcp` cannot distinguish two
 *     agents sharing one hub user; the key can.
 *
 * `undefined` is accepted alongside `null`: `AuthResult.via` is declared
 * `string | null`, but call sites that build the object without the key must
 * degrade to `mcp` rather than throw.
 */
export function refineMcpVia(via: string | null | undefined): string {
  if (via === "operator") return "operator";
  if (typeof via === "string" && via.startsWith("nostr:")) return via;
  return "mcp";
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
        // Not a hardcode with a claim behind it (cloud#278): the operator
        // bearer is an opaque server-wide secret, not a JWT — there is no
        // `permissions` claim to read a tag scope out of, and the operator is
        // unscoped by definition. The JWT branch below is the one that parses.
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

  // TAG SCOPE (cloud#278). Read the claim for real instead of hardcoding
  // `null`. Both non-unscoped outcomes REJECT, because the cloud runtime has
  // no enforcement seam to honour an allowlist with:
  //
  //   - MALFORMED → 401, byte-parity with the bun vault (`auth.ts`
  //     MalformedScopedTagsError → 401 "token has a malformed tag-scope claim").
  //   - WELL-FORMED → 401 too, and this is the cloud-specific half. On bun,
  //     returning the array enforces it: `src/tag-scope.ts` filters every REST
  //     handler, MCP read tool and write gate. Cloud's `rest/tag-scope.ts` is a
  //     documented STUB whose non-null branches no caller can reach —
  //     `AuthResult.scoped_tags` is read NOWHERE in this worker, and every
  //     handler is dispatched with the `NO_TAG_SCOPE` literal (`vault-do.ts`
  //     818/829/832/835/1908/1982). So passing the array through would look
  //     like honouring the claim while serving the WHOLE vault — the silent
  //     widening this issue exists to prevent, only now wearing a parser.
  //
  // This is DEFENSE IN DEPTH, not a live hole. `ALLOWED_ISSUERS` widens which
  // `iss` values are accepted, but `getGuard` passes `jwksOrigin: issuer`, so
  // keys are still fetched from ISSUER_ORIGIN alone and a hub-signed token
  // cannot verify here (`test/allowed-issuers.test.ts` pins that a matching
  // `iss` never rescues a token signed by a key the JWKS doesn't carry; prod's
  // ISSUER_ORIGIN is the cloud identity worker, `wrangler.toml`). So the
  // well-formed branch is unreachable in any current deployment — only one that
  // pointed ISSUER_ORIGIN at a hub could reach it. A loud 401 is the fail-closed
  // answer until cloud ports `parachute-vault/src/tag-scope.ts` and threads a
  // real `TagScopeCtx` from this result through REST + MCP + WS +
  // export/attachments. That port is a feature in its own right, not this fix
  // (tracked in #278).
  let scopedTags: string[] | null;
  try {
    scopedTags = parseScopedTagsFromPermissions(claims.permissions);
  } catch (err) {
    if (err instanceof MalformedScopedTagsError) {
      console.warn(`[auth] JWT rejected: ${err.message}`);
      return { ok: false, reason: "unauthorized", message: "token has a malformed tag-scope claim" };
    }
    throw err;
  }
  if (scopedTags !== null) {
    console.warn(
      `[auth] JWT rejected: permissions.scoped_tags is set (${scopedTags.length} tag(s)) but the ` +
        "cloud vault runtime cannot enforce a tag scope — refusing rather than serving the full vault",
    );
    return {
      ok: false,
      reason: "unauthorized",
      message: "token is tag-scoped, which this vault does not support",
    };
  }

  // Write-attribution axis 2 — the NIP-98 signing pubkey, when present.
  // Fail-soft; see `parsePrincipalPubkey`.
  const principalPubkey = parsePrincipalPubkey(claims.permissions);

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
      // Always `null` HERE by construction — the only way to reach this line is
      // for the parse above to have returned null (unscoped). Written as the
      // parsed variable rather than the literal so the seam is real: when cloud
      // grows tag-scope enforcement, the refusal above is deleted and this line
      // already carries the allowlist.
      scoped_tags: scopedTags,
      actor: claims.sub && claims.sub.length > 0 ? claims.sub : null,
      // VIA: the NIP-98 signing pubkey when the issuer stamped one, else the
      // generic `api` credential class the request path refines. `actor` is
      // untouched — it stays the hub USER id, so two agents sharing one hub
      // user keep one `created_by` and are told apart by `*_via`. (cloud#277)
      via: principalPubkey !== null ? nostrVia(principalPubkey) : "api",
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
 * names no single vault (non-JWT operator/legacy bearer, malformed JWT, or a JWT
 * whose scope / `aud` / `vault_scope` sources name zero or conflicting vaults).
 * Signature/issuer/expiry/revocation are authorization facts and are enforced by
 * the destination DO after routing. Mirrors parachute-vault/src/auth.ts's
 * `VaultDerivation`.
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
 * This routing step deliberately decodes without authenticating. The destination
 * DO is the authorization boundary and runs the complete trust kernel there:
 * signature, issuer, exact `aud=vault.<name>`, expiry, jti/revocation, and scope.
 * A forged token can therefore select and wake a DO but cannot enter it. That is
 * not a new resource primitive: the public URL-addressed
 * `/vault/<arbitrary-name>/mcp` route already lets an unauthenticated caller wake
 * the same DO and receive the same 401. Keeping validation in one place also
 * avoids a second edge-router trust-kernel invocation diverging from the DO.
 * Non-JWT credentials (the operator `VAULT_AUTH_TOKEN`) name no vault →
 * `not_derivable`; they keep working at the URL-addressed surface.
 *
 * Three independent sources can name a vault: a narrowed `vault:<name>:<verb>`
 * scope, an `aud` of the form `vault.<name>`, and a single-element `vault_scope`
 * claim. On an issuer-minted token these AGREE. We collect every name any source
 * provides and require EXACTLY ONE distinct name: zero (nothing named a vault)
 * and two-or-more (the sources disagree) both fail closed with `not_derivable`.
 * We never pick a winner from a precedence order. Mirrors
 * parachute-vault/src/auth.ts's `deriveVaultFromToken`.
 */
export async function deriveVaultFromToken(req: Request, _env: Env): Promise<VaultDerivation> {
  const key = extractApiKey(req);
  if (!key) return { error: "no_bearer" };
  if (!looksLikeJwt(key)) return { error: "not_derivable" };
  let raw: ReturnType<typeof decodeJwt>;
  try {
    raw = decodeJwt(key);
  } catch {
    return { error: "not_derivable" };
  }
  const named = new Set<string>();
  const scopeRaw = typeof raw.scope === "string" ? raw.scope.trim().split(/\s+/).filter(Boolean) : [];
  for (const name of narrowedVaultNames(scopeRaw)) named.add(name);
  const auds =
    typeof raw.aud === "string"
      ? [raw.aud]
      : Array.isArray(raw.aud)
        ? raw.aud.filter((aud): aud is string => typeof aud === "string")
        : [];
  for (const aud of auds) {
    const match = aud.match(/^vault\.(.+)$/);
    if (match) named.add(match[1]!);
  }
  const vaultScope = Array.isArray(raw.vault_scope)
    ? raw.vault_scope.filter((name): name is string => typeof name === "string")
    : [];
  if (vaultScope.length === 1) named.add(vaultScope[0]!);
  if (named.size !== 1) return { error: "not_derivable" };
  return { vaultName: [...named][0]! };
}
