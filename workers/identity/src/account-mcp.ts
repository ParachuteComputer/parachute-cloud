/**
 * The account-level MCP tools (Wave A PR3) — the payload behind the account-MCP
 * door. Three tools, ONE tenant key (the account id from the validated bearer),
 * and the enforcement seam PR2 deferred: **coverage resolves by OWNERSHIP at
 * request time, never by scope-name alone.**
 *
 *   - `list-vaults`   — the coverage set (the account's granted, currently-owned
 *     vaults) with usage + `covered: "all" | "listed"`.
 *   - `create-vault`  — the EXACT REST-create machinery inline (plan vault-count
 *     cap, `createVault`, best-effort cap push). Returns `{ name, url }` and
 *     NEVER a vault_token (a token in model context is a credential leak).
 *   - `query-notes`   — cross-vault read: an optional `vault` targets one vault;
 *     omitted → fan out across the coverage set, per-vault attribution, no
 *     cross-vault ranking (keyword + common tag/metadata/limit subset; semantic
 *     is NOT fanned out in v1).
 *
 * THE OWNERSHIP SEAM (hard requirement from the PR2 review). Every tool call
 * computes the coverage set LIVE as `buildAccountConnectionGrant(scopes, sub)` ∩
 * `listVaultsForOwner(sub)` — {@link resolveCoverage}. A narrowed grant naming a
 * since-deleted (or re-registered-to-someone-else) vault silently DROPS it
 * (fail-closed); a blanket grant means every vault the account CURRENTLY owns,
 * resolved fresh each call (future vaults auto-included, an unowned vault can
 * never be reached). The 4-part scope names are never trusted as an access grant
 * on their own.
 *
 * THE BRIDGE. Every real vault op mints a 60s single-vault token through the
 * SAME `vault-call.ts` seam the console uses (`aud=vault.<name>`,
 * `vault_scope=[name]`, `vault:<name>:read`), but stamped
 * `client_id="parachute-account"` ({@link ACCOUNT_TOKEN_CLIENT_ID}) — NOT the
 * `parachute-console` first-party id the vault worker's internal cap/snapshot
 * seam is gated on. These fan-out reads are exactly as powerful as a vault token
 * the owner can already mint through public OAuth, and no more.
 */
import {
  type ComposedVaultVerb,
  COMPOSED_VERB_RANK,
  accountVaultsGrant,
  composedAccountGrant,
} from "@openparachute/door-contract";
import { ACCOUNT_TOKEN_CLIENT_ID } from "./account-token.ts";
import { type AttributionPrincipal, principalAttributionClaims } from "./tokens.ts";
import { type OAuthDeps, vaultAdvertisedUrl } from "./oauth-shared.ts";
import {
  PLAN_SPECS,
  entitlementPlanFor,
  planEntitlement,
  vaultCapMessage,
} from "./plans.ts";
import type { User } from "./users.ts";
import { callVaultApi, pushVaultCap } from "./vault-call.ts";
import {
  type Vault,
  VaultNameInvalidError,
  VaultNameTakenError,
  countVaultsForOwner,
  createVault,
  listVaultsForOwner,
} from "./vaults.ts";
import { latestUsageForVaults } from "./usage.ts";

/** Per-vault timeout for the query-notes fan-out — a single server-side hop that
 *  must never let one slow/hung vault stall the whole cross-vault read. */
export const FANOUT_TIMEOUT_MS = 10_000;

/** The per-vault `limit` ceiling on a fan-out query. Clamped at this seam
 *  (`buildNotesQuery`) as defense-in-depth: the vault RS enforces its own cap,
 *  but a fan-out multiplies per-call cost across every covered vault, so an
 *  unbounded `limit` is capped BEFORE the mint. */
export const MAX_NOTES_LIMIT = 100;

/**
 * The grant an authenticated account-MCP token carries — the verb-aware,
 * OWNERSHIP-agnostic form straight off the scope string. Unifies the legacy
 * Wave A account-vaults family AND the composed grammar (unified `/mcp`):
 *   - `wildcard` — a grant over EVERY owned vault at this verb: `read` for a
 *     legacy blanket (`account:<id>:vaults`, Wave A read-level, FROZEN) or the
 *     composed wildcard's own verb (`account:<id>:vaults:*:<verb>`); `null` if
 *     no all-vaults grant is present.
 *   - `vaults` — a per-vault-name → verb map: `read` for a legacy narrowed vault
 *     (`account:<id>:vaults:<vault>`), the composed per-vault verb for a 5-part
 *     grant (`account:<id>:vaults:<vault>:<verb>`).
 *   - `create` — the create-vault capability: ALWAYS true under a legacy
 *     account-vaults grant (Wave A create is unconditional), or the composed
 *     `account:<id>:vault-create` flag.
 * The auth gate has already proven it confers SOME coverage (non-null);
 * {@link resolveCoverage} turns it into a live, ownership-checked set.
 */
export interface AccountConnectionGrant {
  wildcard: ComposedVaultVerb | null;
  vaults: Map<string, ComposedVaultVerb>;
  create: boolean;
}

/** Fold `verb` into `map[name]`, keeping the higher rung (`admin ⊇ write ⊇ read`). */
function raiseVaultVerb(map: Map<string, ComposedVaultVerb>, name: string, verb: ComposedVaultVerb): void {
  const cur = map.get(name);
  if (!cur || COMPOSED_VERB_RANK[verb] > COMPOSED_VERB_RANK[cur]) map.set(name, verb);
}

/**
 * Build the connection grant for the account-MCP door from a validated token's
 * account scopes, unifying legacy Wave A + composed. Returns `null` when the set
 * confers NOTHING that opens the door (no all-vaults grant, no per-vault grant,
 * no create capability) — the auth gate maps that to a 403.
 *
 * LEGACY (Wave A) semantics are FROZEN — a legacy grant always confers `create`
 * and read-level vault coverage, byte-identically to the pre-composed behavior:
 * a deployed Wave A account token opens the same tools at the same coverage.
 * COMPOSED grants add verb-awareness (a per-vault write/admin, a wildcard verb)
 * and a distinct create capability. Module grants are NOT part of THIS door
 * (Phase 3) and never open it on their own.
 */
export function buildAccountConnectionGrant(
  scopes: readonly string[],
  accountId: string,
): AccountConnectionGrant | null {
  const composed = composedAccountGrant(scopes, accountId);
  let wildcard = composed.wildcard;
  const vaults = new Map(composed.vaults);
  let create = composed.create;

  // Fold in the legacy Wave A account-vaults family at read-level (FROZEN).
  const legacy = accountVaultsGrant(scopes, accountId);
  if (legacy !== null) {
    create = true; // a Wave A account-vaults connection can always create
    if ("blanket" in legacy) {
      if (wildcard === null) wildcard = "read"; // blanket → all owned, read
    } else {
      for (const name of legacy.vaults) raiseVaultVerb(vaults, name, "read");
    }
  }

  const opensDoor = wildcard !== null || vaults.size > 0 || create;
  return opensDoor ? { wildcard, vaults, create } : null;
}

/**
 * A business-level tool failure that maps to a structured JSON-RPC error
 * (`error.data.error_type`) rather than an opaque in-band `isError` string —
 * mirroring the vault worker's `mapDomainError` default branch so an agent keys
 * off the SAME discriminator on either door.
 */
export class AccountToolError extends Error {
  constructor(
    public readonly errorType: string,
    message: string,
    public readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AccountToolError";
  }
}

/** The live coverage set for a call: the vaults the grant covers AND the account
 *  CURRENTLY owns. `covered` distinguishes the blanket grant ("all") from a
 *  consent-narrowed one ("listed") for the model's benefit. */
export interface Coverage {
  covered: "all" | "listed";
  /** The covered Vault rows (owned ∩ grant), in ownership order. */
  vaults: Vault[];
  /** Just the names — the fan-out target set. */
  names: string[];
  /** Whether the connection may create new vaults (grant.create). */
  create: boolean;
}

/**
 * THE ENFORCEMENT SEAM. Resolve what a grant covers by OWNERSHIP, live, at call
 * time:
 *   - a wildcard grant (legacy blanket OR composed `vaults:*:<verb>`) → every
 *     vault the account currently owns (future vaults auto-included; an unowned
 *     vault can never appear);
 *   - otherwise the per-vault names INTERSECTED with current ownership (a name
 *     for a since-deleted / re-registered vault silently drops — fail-closed).
 * Never trusts the scope names alone. `create` rides through from the grant (it
 * is an account-level capability, independent of any specific vault's ownership).
 */
export async function resolveCoverage(
  db: D1Database,
  accountId: string,
  grant: AccountConnectionGrant,
): Promise<Coverage> {
  const owned = await listVaultsForOwner(db, accountId);
  if (grant.wildcard !== null) {
    return { covered: "all", vaults: owned, names: owned.map((v) => v.name), create: grant.create };
  }
  const byName = new Map(owned.map((v) => [v.name, v]));
  const vaults = [...grant.vaults.keys()]
    .map((n) => byName.get(n))
    .filter((v): v is Vault => v !== undefined);
  return { covered: "listed", vaults, names: vaults.map((v) => v.name), create: grant.create };
}

/** The per-call context the tool executors run against. */
export interface AccountToolContext {
  db: D1Database;
  deps: OAuthDeps;
  accountId: string;
  grant: AccountConnectionGrant;
  /** The account owner, loaded once by the auth gate (suspended-refusal) and
   *  reused by create-vault's plan gate — never re-read per tool. */
  user: User;
  /**
   * How this connection authenticated (cloud#278 / hub#937). The cloud door
   * is Bearer-only today (`authKind: "bearer"`) — there is no NIP-98 path in
   * this worker, so hop tokens never carry `permissions.principal_pubkey`.
   * When a NIP-98 door lands, set `authKind: "nostr"` and `pubkey` from the
   * VERIFIED event; {@link principalAttributionClaims} is the only producer.
   */
  principal: AttributionPrincipal;
}

/** A single account-MCP tool: a pure definition + an executor that throws
 *  {@link AccountToolError} on a business failure. */
export interface AccountMcpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(args: Record<string, unknown>, ctx: AccountToolContext): Promise<unknown>;
}

// --- list-vaults -------------------------------------------------------------

const listVaultsTool: AccountMcpTool = {
  name: "list-vaults",
  description:
    "List the vaults this account can reach through the connection — the granted, currently-owned vaults. " +
    "Returns each vault's name, URL, creation time, and latest recorded storage usage, plus whether the grant " +
    "covers ALL of the account's vaults or a specific listed subset.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async execute(_args, ctx) {
    const coverage = await resolveCoverage(ctx.db, ctx.accountId, ctx.grant);
    const usage = await latestUsageForVaults(ctx.db, coverage.names);
    const vaults = coverage.vaults.map((v) => {
      const row = usage.get(v.name);
      return {
        name: v.name,
        vault_id: v.vaultId,
        url: vaultAdvertisedUrl(v.name, ctx.deps),
        created_at: v.createdAt,
        usage: row ? { notes_bytes: row.dbBytes, attachment_bytes: row.r2Bytes } : null,
      };
    });
    return { covered: coverage.covered, vaults };
  },
};

// --- create-vault ------------------------------------------------------------

const createVaultTool: AccountMcpTool = {
  name: "create-vault",
  description:
    "Create a new vault under this account. Returns the new vault's name and URL. " +
    "The vault is subject to the account's plan vault-count limit.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description:
          "The vault name (2–63 characters: lowercase letters, numbers, and hyphens, starting with a letter or number).",
      },
    },
    required: ["name"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const { db, deps, user } = ctx;
    // Capability gate — the connection must carry the create-vault capability.
    // Legacy Wave A account-vaults grants confer it unconditionally (create is a
    // frozen Wave A capability); a composed grant confers it only via
    // `account:<id>:vault-create`. A composed connection WITHOUT it can list +
    // query but never create.
    if (!ctx.grant.create) {
      throw new AccountToolError(
        "create_not_granted",
        "This connection was not granted permission to create vaults.",
      );
    }
    // Plan vault-count gate — IDENTICAL to handleAccountVaultCreate / the
    // console's handleCreateVaultPost: `>=` grandfathers users already over a
    // cap (an expired plan has vault_count=0 → refused here).
    const spec = PLAN_SPECS[user.plan];
    if ((await countVaultsForOwner(db, user.id)) >= spec.vault_count) {
      throw new AccountToolError("vault_limit_reached", vaultCapMessage(user.plan));
    }

    const rawName = typeof args.name === "string" ? args.name : "";
    let created: Vault;
    try {
      created = await createVault(db, rawName, user.id, deps.now?.() ?? new Date());
    } catch (err) {
      if (err instanceof VaultNameInvalidError) {
        throw err.reason === "reserved"
          ? new AccountToolError("reserved", "That name is reserved. Please choose another.")
          : new AccountToolError(
              "invalid_name",
              "Use 2–63 characters: lowercase letters, numbers, and hyphens (starting with a letter or number).",
            );
      }
      if (err instanceof VaultNameTakenError) {
        throw new AccountToolError("vault_taken", "That vault name is already taken.");
      }
      throw err;
    }

    // Best-effort cap push (same contract as the console/account-API create door:
    // a hiccup leaves the DO on the more-generous env default; applyPlanToVaults /
    // the backfill reconcile). Uses the first-party `parachute-console` mint
    // (callVaultApi's default) — the internal config seam, NOT the tenant path.
    await pushVaultCap(db, deps, user.id, created.name, planEntitlement(entitlementPlanFor(user.plan, user.pendingPlan)));

    // NO vault_token in the result — a token in model context is a credential
    // leak. The app mints one out-of-band via POST /account/vaults/<name>/token.
    return { name: created.name, vault_id: created.vaultId, url: vaultAdvertisedUrl(created.name, deps) };
  },
};

// --- query-notes (the ownership-resolved fan-out) ----------------------------

/** One vault's contribution to a fan-out — either its notes payload or an
 *  isolated error (a failed vault never fails the whole call). */
type VaultQueryEntry = { vault: string; notes: unknown } | { vault: string; error: string };

/**
 * Build the vault REST `/api/notes` query string from the Wave A common subset
 * (`search` + `tag` + `metadata` + `limit`). `metadata` rides the JSON `metadata=`
 * param the vault REST accepts (mutually exclusive with the bracket form, which
 * we never emit). Under full-text `search` the vault honors only `tag` + `limit`
 * (metadata is inert there) — the documented common-subset boundary; full
 * per-param parity across vaults is Wave B.
 */
function buildNotesQuery(args: Record<string, unknown>): string {
  const p = new URLSearchParams();
  if (typeof args.search === "string" && args.search.length > 0) p.set("search", args.search);
  const rawTags = Array.isArray(args.tag) ? args.tag : typeof args.tag === "string" ? [args.tag] : [];
  for (const t of rawTags) if (typeof t === "string" && t.length > 0) p.append("tag", t);
  if (args.metadata && typeof args.metadata === "object") p.set("metadata", JSON.stringify(args.metadata));
  const rawLimit =
    typeof args.limit === "number"
      ? args.limit
      : typeof args.limit === "string"
        ? Number.parseInt(args.limit, 10)
        : undefined;
  if (rawLimit !== undefined && Number.isFinite(rawLimit)) {
    // Defense-in-depth clamp to [1, MAX_NOTES_LIMIT]. A fan-out multiplies each
    // vault's per-call cost by the number of covered vaults, so an unbounded
    // `limit` passed straight through is a cheap way to amplify a cross-vault
    // read. The vault RS also enforces its own ceiling; we clamp here too so the
    // amplification is capped at THIS seam, before the mint fans out.
    const clamped = Math.min(Math.max(1, Math.floor(rawLimit)), MAX_NOTES_LIMIT);
    p.set("limit", String(clamped));
  }
  return p.toString();
}

/**
 * Query ONE vault through the bridge mint. Throws on transport/timeout (the
 * caller's `Promise.allSettled` converts that to an isolated `{ vault, error }`);
 * returns a `{ vault, error }` for a non-2xx (the vault answered, unhappily) and
 * `{ vault, notes }` on success. The mint is a 60s `vault:<name>:read` token
 * stamped `client_id="parachute-account"`, aborted at {@link FANOUT_TIMEOUT_MS}.
 */
async function queryOneVault(
  db: D1Database,
  deps: OAuthDeps,
  accountId: string,
  vaultName: string,
  args: Record<string, unknown>,
  permissions?: Record<string, unknown>,
): Promise<VaultQueryEntry> {
  const qs = buildNotesQuery(args);
  const res = await callVaultApi(db, deps, {
    userId: accountId,
    vaultName,
    method: "GET",
    apiPath: qs ? `/api/notes?${qs}` : "/api/notes",
    verb: "read",
    clientId: ACCOUNT_TOKEN_CLIENT_ID,
    signal: AbortSignal.timeout(FANOUT_TIMEOUT_MS),
    ...(permissions !== undefined ? { permissions } : {}),
  });
  if (!res.ok) {
    let detail = `vault responded ${res.status}`;
    try {
      const body = (await res.json()) as Record<string, unknown>;
      if (typeof body.error === "string") detail = body.error;
    } catch {
      // Non-JSON error body — keep the status-only detail.
    }
    return { vault: vaultName, error: detail };
  }
  const notes = await res.json();
  return { vault: vaultName, notes };
}

/**
 * Fan a keyword/structured query out across `targets`, concurrently. Uses
 * `Promise.allSettled` so a rejection (timeout / transport error) on one vault
 * becomes that vault's `{ vault, error }` entry — never a whole-call failure —
 * and results stay GROUPED per vault with attribution (no cross-vault ranking).
 */
async function fanOut(
  db: D1Database,
  deps: OAuthDeps,
  accountId: string,
  targets: string[],
  args: Record<string, unknown>,
  permissions?: Record<string, unknown>,
): Promise<VaultQueryEntry[]> {
  const settled = await Promise.allSettled(
    targets.map((name) => queryOneVault(db, deps, accountId, name, args, permissions)),
  );
  return settled.map((s, i) =>
    s.status === "fulfilled"
      ? s.value
      : { vault: targets[i]!, error: s.reason instanceof Error ? s.reason.message : "query failed" },
  );
}

const queryNotesTool: AccountMcpTool = {
  name: "query-notes",
  description:
    "Search notes across the account's vaults. Omit `vault` to fan the query out across every reachable vault " +
    "(results are grouped per vault, not ranked across vaults); pass `vault` to target one. Wave A supports " +
    "keyword `search`, `tag` and `metadata` filters, and `limit` (semantic search is per-vault only, not fanned out).",
  inputSchema: {
    type: "object",
    properties: {
      vault: {
        type: "string",
        description:
          "Target a single vault by name. Must be one of the account's granted, currently-owned vaults. Omit to query all.",
      },
      search: { type: "string", description: "Full-text keyword query." },
      tag: {
        type: ["string", "array"],
        items: { type: "string" },
        description: "Restrict to notes carrying this tag (or any of these tags).",
      },
      metadata: {
        type: "object",
        description:
          "Structured metadata filters, e.g. {\"status\":{\"eq\":\"open\"}} (applies to non-search queries).",
      },
      limit: { type: "number", description: "Maximum notes per vault (default 50)." },
    },
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const coverage = await resolveCoverage(ctx.db, ctx.accountId, ctx.grant);
    let targets = coverage.names;
    if (typeof args.vault === "string" && args.vault.length > 0) {
      const wanted = args.vault.toLowerCase();
      // Fail-closed: a `vault` outside the live coverage set is refused, never
      // silently reached — the ownership seam applies to the targeted form too.
      if (!coverage.names.includes(wanted)) {
        throw new AccountToolError(
          "vault_not_covered",
          `Vault "${args.vault}" is not among your granted, currently-owned vaults.`,
        );
      }
      targets = [wanted];
    }
    const attribution = principalAttributionClaims(ctx.principal);
    const results = await fanOut(
      ctx.db,
      ctx.deps,
      ctx.accountId,
      targets,
      args,
      attribution?.permissions,
    );
    return { vaults_queried: targets, results };
  },
};

/** The account-MCP tool set — EXACTLY three tools (Wave A). Order is stable so
 *  `tools/list` is deterministic. */
export const ACCOUNT_MCP_TOOLS: readonly AccountMcpTool[] = [listVaultsTool, createVaultTool, queryNotesTool];
