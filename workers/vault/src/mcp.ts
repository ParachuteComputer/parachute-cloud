/**
 * MCP endpoint for the Vault DO — Streamable HTTP, stateless per request.
 *
 * The "connect your AI" moment (design §3.1). Ground truth is bun's
 * `parachute-vault/src/mcp-http.ts`, which builds a fresh MCP `Server` +
 * `WebStandardStreamableHTTPServerTransport` per call (stateless: no session
 * id). We reproduce that transport's *exact wire behavior* by hand rather than
 * pulling the SDK into workerd — the SDK's server core drags in ajv (dynamic
 * codegen, blocked under workerd) + a heavy zod/express dep tree, and the
 * stateless surface Claude needs is small. Byte-shape parity with the SDK is
 * the contract (any subtle miss presents as an opaque connector failure), so
 * every rule below is transcribed from
 * `@modelcontextprotocol/sdk` webStandardStreamableHttp.js @ 1.12.1:
 *
 *   - POST only carries JSON-RPC. The Accept header MUST list BOTH
 *     `application/json` AND `text/event-stream` → else 406 (-32000). The
 *     Content-Type MUST be `application/json` → else 415 (-32000). Bad JSON →
 *     400 (-32700); a non-JSON-RPC message → 400 (-32700).
 *   - A batch/message with no *requests* (only notifications) → 202, empty body.
 *   - Requests are answered in JSON-response mode: a single request returns the
 *     lone response object; a batch returns an array. `Content-Type:
 *     application/json`. (Stateless → no `Mcp-Session-Id` header ever.)
 *   - GET (the server-push SSE stream) → 405. Cloud v1 has no server-initiated
 *     notifications, and an idle GET stream would pin the DO awake and bill
 *     duration (design §3.1 / Phase-4 WS-hibernation note). Claude only needs
 *     the POST path. DELETE (session teardown) → 200 no-op (nothing to tear
 *     down in stateless mode).
 *
 * Tools come from core's transport-agnostic `generateMcpTools(store)` (proven
 * under workerd by the Phase-0 spike), filtered + verb-gated by the caller's
 * per-vault scope exactly as bun's mcp-http.ts does. The domain-error → JSON-RPC
 * mapping (conflict / transition_conflict / schema_validation /
 * precondition_required carrying structured `data`) mirrors mcp-http.ts so an
 * agent keys off the same discriminators on either runtime.
 */
import type { Database } from "bun:sqlite";
import { generateMcpTools, type McpToolDef } from "@openparachute/core/src/mcp.js";
import { buildVaultProjection, attachmentsInstructionBlock, connectionReach } from "@openparachute/core/src/vault-projection.js";
import type { Store } from "@openparachute/core/src/types.js";
import type { AttachmentTicketProvider } from "@openparachute/core/src/attachment/tickets.js";
import type { AttachmentBytesProvider } from "@openparachute/core/src/attachment/bytes-provider.js";
import { hasScopeForVault, refineMcpVia, type AuthResult, type VaultVerb } from "./auth.js";
import { applyOnBehalf } from "./rest/write-stamp.js";
import { recordWords, shape09, toolHelp } from "./mcp-09.js";
import { errorClass, toolErrorOutcome } from "./health.js";

// Transcribed from the SDK's types.js so negotiation matches byte-for-byte.
const LATEST_PROTOCOL_VERSION = "2025-11-25";
const SUPPORTED_PROTOCOL_VERSIONS = [
  LATEST_PROTOCOL_VERSION,
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
];

/**
 * MCP 2026-07-28, the "modern" era (T-307). It has no initialize handshake:
 * every request carries its version and client capabilities in `params._meta`
 * and the `MCP-Protocol-Version` header, plus `Mcp-Method` (and `Mcp-Name` for
 * tools/call); `server/discover` replaces initialize as the way to learn the
 * server. This door is dual-era (spec basic/versioning.mdx): a request that
 * carries a modern `_meta` version, or a modern version header, is served by
 * {@link handleModern}; everything else keeps the legacy behavior above byte
 * for byte. ChatGPT is reported to speak this revision, and was refused with
 * "Unsupported protocol version" before.
 */
const MODERN_PROTOCOL_VERSIONS = ["2026-07-28"];
const ALL_SUPPORTED_VERSIONS = [...MODERN_PROTOCOL_VERSIONS, ...SUPPORTED_PROTOCOL_VERSIONS];
const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";
// Spec-reserved codes (basic/index.mdx "Error Codes").
const HEADER_MISMATCH = -32020;
const UNSUPPORTED_PROTOCOL_VERSION = -32022;
/** CacheableResult hint for server/discover + tools/list: the tool set only moves with a deploy or a new token. */
const MODERN_CACHE_TTL_MS = 300_000;

// JSON-RPC error codes (SDK types.js ErrorCode).
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

type JsonRpcId = string | number | null;
interface JsonRpcMessage {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

/** The SDK's `createJsonErrorResponse`: `{jsonrpc,error:{code,message},id:null}`. */
function jsonRpcHttpError(status: number, code: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function result(id: JsonRpcId, value: unknown): JsonRpcMessage {
  return { jsonrpc: "2.0", id, result: value };
}
function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcMessage {
  return { jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } };
}

function isJsonRpc(m: unknown): m is JsonRpcMessage {
  return !!m && typeof m === "object" && (m as JsonRpcMessage).jsonrpc === "2.0";
}
/** A request carries both a method and an id; a notification has no id. */
function isRequest(m: JsonRpcMessage): boolean {
  return typeof m.method === "string" && m.id !== undefined;
}

function requiredVerbForTool(tool: { requiredVerb?: VaultVerb }): VaultVerb {
  return tool.requiredVerb ?? "write";
}

/**
 * The per-tool write gate — the paywall + cap PARITY with the REST write path.
 * The DO passes `() => this.capBlockIfFull()`, i.e. the SAME frozen-then-cap
 * check the REST POST/PATCH/PUT gate applies, and MCP invokes it BEFORE running
 * a forward-mutating tool. Returns the REST Response (402 `plan_required` when
 * frozen / 413 `storage_cap_exceeded` when a meter is full) or null when the
 * write is allowed. All MCP is POST JSON-RPC, so the gate CANNOT live at the
 * HTTP layer (that would wrongly block reads) — it is applied per tool.
 */
export type McpWriteGate = () => Response | null;

/**
 * MCP tools whose REST equivalent is a DELETE. The REST cap/frozen gate exempts
 * DELETE (a tenant at the cap — or an expired/frozen one — must always be able
 * to delete their way back down; the frozen floor leaves reads + export + DELETE
 * untouched, see caps.ts). We mirror that here so MCP is neither stricter nor
 * looser than REST: read-class tools AND these delete-class tools pass through
 * the gate; every other forward-mutating write/admin tool is gated.
 */
// door/0.9: delete-record is delete-note under its record name; manage-types {action: "delete"} is delete-tag's.
const DELETE_CLASS_TOOLS = new Set(["delete-note", "delete-tag", "delete-record"]);

/**
 * The attachment-ticket upload mint (`core/src/mcp.ts`'s
 * `request-attachment-upload`) is `requiredVerb: "write"` but must NOT run
 * through the generic {@link isGatedWrite} → `writeGate()` path: that gate
 * checks the NOTES meter (`capBlockIfFull`), and a mint is an ATTACHMENT
 * write — it needs the attachment meter's own ladder (frozen →
 * `attachments_not_included` → attachment cap), exactly the one REST's
 * storage upload and the ticket spend route run (`caps.ts`,
 * `attachment-tickets.ts`). See `handleToolCall`'s dedicated branch.
 */
const ATTACHMENT_UPLOAD_MINT_TOOL = "request-attachment-upload";

/** The upload mint under either name: the old tool, or 0.9's `attachment-url {action: "upload"}` (door/0.9). */
function isAttachmentUploadMint(name: string, args: Record<string, unknown>): boolean {
  return name === ATTACHMENT_UPLOAD_MINT_TOOL || (name === "attachment-url" && args.action === "upload");
}

/** A forward-mutating tool (create/update/prune) — the class the REST
 *  POST/PATCH/PUT cap+frozen gate covers. Read tools, DELETE-class tools, and
 *  the attachment-upload mint (which runs its OWN gate — see
 *  {@link ATTACHMENT_UPLOAD_MINT_TOOL}) are exempt, so this is the exact
 *  "should the NOTES write gate run" predicate.
 *
 *  vault-info is the one read-verb tool that can ALSO mutate: it is
 *  `requiredVerb: "read"` (a read-only caller must keep the stats projection and
 *  reads stay sacred on a frozen vault), but a call carrying `description`
 *  UPDATES the vault description — a real write. So gate it exactly when
 *  `description` is present. The inner SCOPE check (`vault:admin` — the 0.7.1
 *  re-tier) lives in overrideVaultInfo; this is the paywall/cap half (frozen →
 *  402, cap-full → 413), mirroring the REST write path. */
function isGatedWrite(tool: McpToolDef, args: Record<string, unknown>): boolean {
  if (tool.name === "vault-info") return args.description !== undefined;
  if (isAttachmentUploadMint(tool.name, args)) return false;
  // attachment-url {download} is a read; manage-types {delete} is delete-tag (exempt like REST DELETE).
  if (tool.name === "attachment-url") return false;
  if (tool.name === "manage-types" && args.action === "delete") return false;
  if (tool.name === "manage-types") return true;
  return requiredVerbForTool(tool) !== "read" && !DELETE_CLASS_TOOLS.has(tool.name);
}

/**
 * Convert a REST cap/frozen Response (402 `plan_required` / 413
 * `storage_cap_exceeded`) into the mirrored JSON-RPC error: the REST body rides
 * verbatim in `data` so an agent keys off the SAME `error_type` discriminator on
 * either runtime, and the REST `message` becomes the JSON-RPC message. Reusing
 * the REST Response body (never a hand-rolled shape) keeps MCP and REST from
 * drifting.
 */
async function gateError(id: JsonRpcId, blocked: Response): Promise<JsonRpcMessage> {
  const data = (await blocked.json().catch(() => ({}))) as Record<string, unknown>;
  const message = typeof data.message === "string" ? data.message : "This write is not permitted.";
  return rpcError(id, INVALID_REQUEST, message, data);
}

/**
 * The connect-time server instruction (bun sends the vault's projection as the
 * MCP `instructions`; the vault teaches the AI how to use it). Cloud v1 sends a
 * faithful-but-simple brief built from the vault description — the rich schema
 * projection (`buildVaultProjection`) is a documented follow-up; the
 * connector-critical bytes are the discovery chain + tool list, not this text.
 *
 * The Attachments orientation paragraph rides the SAME core helper bun's
 * `projectionToMarkdown` folds in (`attachmentsInstructionBlock`, D0/§2a of
 * the design) — one source for the sentence teaching `request-attachment-
 * upload`/`-download`, so the two doors can't drift on it even though cloud
 * doesn't (yet) adopt the full projection. `ticketsEnabled: true`
 * unconditionally — this door always wires an `AttachmentTicketProvider`
 * (see `VaultDO`'s constructor), same as bun.
 *
 * `reach` (0.9.1, SPEC §3.4) is the engine's own sentence for what this
 * connection can read (`connectionReachFor`), on the line right under the one
 * that names the vault. Omitted: no line.
 */
export function serverInstruction(vaultName: string, description: string | null, reach?: string): string {
  const base =
    `Parachute vault "${vaultName}" — an agent-native knowledge graph of records, types, tags, and links. ` +
    `Read with query-records; write with create-record / update-record; see and change types with list-types / ` +
    `manage-types; orient with vault-info (vault-info {help: "<tool>"} gives any tool's every parameter).`;
  // cloud#87 — defensive `typeof`, not decoration: this is the DETONATION site
  // for a non-string description. `description?.trim()` on a number throws, and
  // `initialize` catches every throw into a -32603 INTERNAL_ERROR, so a poisoned
  // vault could not be CONNECTED to at all — and `initialize` is the first frame,
  // so the connected AI never reaches a tool that could repair it. Both cloud
  // write doors now reject a non-string at the execute (overrideVaultInfo /
  // rest/vault.ts), but a vault poisoned BEFORE this shipped — or through a door
  // that still carries the unchecked cast (the bun vault's mcp-tools.ts still
  // does, cloud#87 is only half-closed) — must still be able to reconnect. A
  // non-string degrades to "no description": the vault connects with the base
  // brief instead of refusing the session.
  const d = typeof description === "string" ? description.trim() : undefined;
  const named = reach ? `${base}\n${reach}` : base;
  const head = d ? `${d}\n\n${named}` : named;
  return `${head}\n\n${recordWords(attachmentsInstructionBlock({ ticketsEnabled: true, ticketTool: "attachment-url" }))}`;
}

/**
 * What this connection can read, in the engine's words (`connectionReach`, the box's mcp-tools.ts does the same):
 * the key's highest verb on this vault, and its tag scope. Never less than the key can do.
 */
export function connectionReachFor(auth: AuthResult, vaultName: string): string {
  const level = hasScopeForVault(auth.scopes, vaultName, "admin") ? "admin" : hasScopeForVault(auth.scopes, vaultName, "write") ? "write" : "read";
  return connectionReach(level, auth.scoped_tags);
}

/**
 * Server-layer context the DO supplies so vault-info can build a REAL projection
 * and persist description updates. core's vault-info `execute` is a placeholder
 * ("vault-info must be configured by the server layer", core/src/mcp.ts) that
 * EVERY door must override with its own vault config + db handle. The bun door
 * does this in mcp-tools.ts (`overrideVaultInfo`); this is the cloud DO's
 * equivalent seam.
 */
export interface VaultInfoContext {
  /** The bun:sqlite-`Database`-shaped DB handle (the DO's DatabaseShim / store.db)
   *  for `buildVaultProjection`. */
  db: Database;
  /** Persist a new vault description into the DO's config store. Called only on
   *  the gated description-update branch (after the inner admin-scope check
   *  passes, the cloud#87 type guard has run, and the dispatch-layer frozen/cap
   *  gate has cleared). Resolves after the config `put` lands.
   *
   *  `string | null` — `null` CLEARS the description, and always could: the DO's
   *  config field is `string | null` and a `description: null` argument already
   *  flowed through here. The parameter type just said `string` and leaned on
   *  the caller's `as string` cast to hide it; cloud#87 replaced that cast with a
   *  real check, so the seam now states the type it actually accepts. */
  updateDescription: (description: string | null) => void | Promise<void>;
}

/** Public-facing origin, honoring a proxy's X-Forwarded-* (Cloudflare sets Host).
 *  Mirrors discovery.ts so vault-info coordinates match the discovery-chain URLs. */
function publicOrigin(req: Request): string {
  const fwdHost = req.headers.get("x-forwarded-host");
  const fwdProto = req.headers.get("x-forwarded-proto");
  if (fwdHost) return `${fwdProto || "https"}://${fwdHost}`;
  return new URL(req.url).origin;
}

/**
 * Override core's placeholder vault-info `execute` with a real projection —
 * mirroring bun's `overrideVaultInfo` (parachute-vault/src/mcp-tools.ts). Reuses
 * core's `buildVaultProjection` (ZERO fork) for tags-with-schemas (own + effective
 * inheritance), the indexed-metadata-field catalog, query hints, the
 * getting-started pointer, and optional stats; the door adds its own vault NAME,
 * public coordinates, and the description get/update.
 *
 * The description-UPDATE branch is a write: it (1) requires `vault:admin` for THIS
 * vault (the inner check here — vault-info stays `requiredVerb: "read"` so
 * read-only callers keep the stats projection; admin, not write, per the 0.7.1
 * write/admin re-tier — description is curation) and (2) is separately routed
 * through the #82 write gate at the dispatch layer (`isGatedWrite` treats
 * vault-info-with-`description` as a gated write → a frozen vault refuses with the
 * SAME 402 `plan_required` shape as create-note; a plain read carries no
 * `description`, skips the gate, and works on a frozen vault — reads stay sacred).
 */
function overrideVaultInfo(
  tools: McpToolDef[],
  opts: {
    vaultName: string;
    auth: AuthResult;
    description: string | null;
    origin: string;
    ctx: VaultInfoContext;
  },
): void {
  const { vaultName, auth, ctx } = opts;
  const vaultInfo = tools.find((t) => t.name === "vault-info");
  if (!vaultInfo) return;

  vaultInfo.execute = async (params) => {
    // `help` (0.9): a tool's full reference, which the short tools/list descriptions point to.
    if (params.help !== undefined) {
      if (params.description !== undefined && params.description !== null) {
        throw Object.assign(new Error("vault-info: pass help or description, not both."), { error_type: "invalid_query", field: "help", hint: "two calls" });
      }
      return toolHelp(String(params.help));
    }
    let description = opts.description;

    if (params.description !== undefined) {
      // Inner scope check (parity with bun's overrideVaultInfo): vault-info is
      // read-gated so read-only callers can fetch stats, but MUTATING the
      // description requires ADMIN for THIS vault (was `write` — tightened by
      // the vault 0.7.1 write/admin re-tier: the vault's own description is
      // curation, same class as update-tag et al, not content authorship).
      // Without this a `vault:read`/`vault:write` token could slip a
      // higher-tier mutation past a tool the outer gate considers a read.
      // (The frozen/cap paywall is applied at the dispatch layer — see
      // isGatedWrite/handleToolCall — so this only guards SCOPE.)
      //
      // The REST door matches since T-419 (audit L3-01): `PATCH /api/vault` with a `description` needs admin too
      // (vault-do.ts), so this check is a real boundary, not an advisory one.
      if (!hasScopeForVault(auth.scopes, vaultName, "admin")) {
        throw new Error(
          `Forbidden: updating the vault description requires the 'vault:admin' scope (or 'vault:${vaultName}:admin'). Granted scopes: ${auth.scopes.join(" ") || "(none)"}.`,
        );
      }
      // cloud#87 — the RUNTIME type guard the old `as string` cast stood in
      // for. `params` is untyped JSON off the wire, so the cast was a claim, not
      // a check: an admin-scoped caller could persist a non-string description
      // into the DO config, and it then detonated on the NEXT `initialize` in
      // serverInstruction()'s `description?.trim()` → -32603 INTERNAL_ERROR on
      // connect, with no reachable repair path.
      //
      // Refused through the tool's NORMAL validation channel — a duck-typed
      // `error_type` error, which mapDomainError's generic branch turns into
      // JSON-RPC -32602 INVALID_PARAMS carrying structured `data`. That is the
      // SAME shape core's own validation leaves take (core/src/mcp.ts
      // `structuredError`, e.g. update-tag's `invalid_parent_names`); no new
      // error family, and deliberately NOT a bare throw, which would degrade to
      // the very INTERNAL_ERROR this fix is about.
      //
      // `null` stays legal — it CLEARS the description.
      const next = params.description;
      if (next !== null && typeof next !== "string") {
        const got = Array.isArray(next) ? "array" : typeof next;
        throw Object.assign(
          new Error(`vault-info: description must be a string, or null to clear it (got ${got}).`),
          {
            error_type: "invalid_description",
            field: "description",
            got: next,
            hint: "pass a string, or null to clear the description",
          },
        );
      }
      description = next;
      await ctx.updateDescription(description);
    }

    const includeStats = Boolean(params.include_stats);
    const projection = buildVaultProjection(ctx.db, { includeStats });

    // Cloud always knows its public origin (the request arrived through it), so
    // base_url is always absolute — unlike bun's loopback-fallback null case.
    const base = opts.origin.replace(/\/$/, "");
    const result: Record<string, unknown> = {
      name: vaultName,
      description: description ?? null,
      coordinates: {
        name: vaultName,
        base_url: `${base}/vault/${vaultName}`,
        rest_api: `${base}/vault/${vaultName}/api`,
        mcp: `${base}/vault/${vaultName}/mcp`,
      },
      tags: projection.tags,
      indexed_fields: projection.indexed_fields,
      query_hints: projection.query_hints,
      map: projection.map,
    };
    if (projection.getting_started) result.getting_started = projection.getting_started;
    if (projection.stats) result.stats = projection.stats;
    return result;
  };
}

/**
 * Map a core domain error to its JSON-RPC error shape. A port of bun's
 * chain in parachute-vault/src/mcp-http.ts (the wire contract at the
 * pinned core SHA), branch for branch and in the same order: the two
 * `error_type`-keyed honest-query branches first, the four write-path
 * classes, then QueryError/CursorError matched on `.name` (their `code`
 * is not a fixed discriminator), the five `.code`-keyed classes, and the
 * generic `error_type` backstop. `null` = a truly unknown error; the
 * caller renders that as in-band `isError: true` text.
 */
function mapDomainError(err: unknown): { code: number; data: Record<string, unknown> } | null {
  const e = err as {
    name?: string;
    code?: string;
    note_id?: string;
    note_path?: string | null;
    current_updated_at?: string | null;
    expected_updated_at?: string;
    field?: string;
    expected_from?: unknown;
    to?: unknown;
    current?: unknown;
    violations?: unknown;
    error_type?: string;
    got?: unknown;
    hint?: string;
    path?: string;
    candidates?: unknown;
    extension?: string;
    reason?: string;
    limit?: number;
    tag?: string;
    cycle?: unknown;
    referencing_tags?: unknown;
    how_to?: string;
    size?: number;
    max_bytes?: number;
    mime_type?: string;
    origin?: string;
    import_ix?: number;
  };
  if (e?.error_type === "invalid_query") {
    return {
      code: INVALID_PARAMS,
      data: {
        error_type: "invalid_query",
        field: e.field,
        got: e.got,
        hint: e.hint,
        ...(e.how_to !== undefined ? { how_to: e.how_to } : {}),
      },
    };
  }
  if (e?.error_type === "invalid_search_syntax") {
    return {
      code: INVALID_PARAMS,
      data: { error_type: "invalid_search_syntax", field: e.field, got: e.got, hint: e.hint },
    };
  }
  if (e?.code === "CONFLICT") {
    return {
      code: INVALID_REQUEST,
      data: {
        error_type: "conflict",
        current_updated_at: e.current_updated_at ?? null,
        your_updated_at: e.expected_updated_at,
        path: e.note_path ?? null,
        note_id: e.note_id,
        hint: "re-read the note (query-notes) and re-apply your change against its current updated_at, or pass force: true to overwrite",
      },
    };
  }
  if (e?.code === "TRANSITION_CONFLICT") {
    return {
      code: INVALID_REQUEST,
      data: {
        error_type: "transition_conflict",
        note_id: e.note_id,
        path: e.note_path ?? null,
        field: e.field,
        expected_from: e.expected_from,
        to: e.to,
        current: e.current ?? null,
        hint: "re-read the note's current value for this field and retry the transition from its actual current state",
      },
    };
  }
  if (e?.code === "SCHEMA_VALIDATION") {
    return {
      code: INVALID_PARAMS,
      data: {
        error_type: "schema_validation",
        violations: e.violations ?? [],
        hint: "fix every field listed in violations and retry — none of this write was applied",
      },
    };
  }
  if (e?.code === "PRECONDITION_REQUIRED") {
    return {
      code: INVALID_PARAMS,
      data: {
        error_type: "precondition_required",
        note_id: e.note_id,
        path: e.note_path ?? null,
        hint: "re-read the note, pass its updated_at as if_updated_at, or pass force: true to skip the check",
      },
    };
  }
  if (e?.name === "QueryError") {
    return {
      code: INVALID_PARAMS,
      data: { error_type: e.error_type ?? "invalid_query", code: e.code, field: e.field, got: e.got, hint: e.hint },
    };
  }
  if (e?.name === "CursorError" && typeof e.code === "string") {
    return { code: INVALID_PARAMS, data: { error_type: e.code } };
  }
  if (e?.code === "PATH_CONFLICT") {
    return { code: INVALID_REQUEST, data: { error_type: "path_conflict", path: e.path } };
  }
  if (e?.code === "AMBIGUOUS_PATH") {
    return { code: INVALID_REQUEST, data: { error_type: "ambiguous_path", path: e.path, candidates: e.candidates } };
  }
  if (e?.code === "INVALID_EXTENSION") {
    return { code: INVALID_PARAMS, data: { error_type: "invalid_extension", extension: e.extension, reason: e.reason } };
  }
  if (e?.code === "BATCH_TOO_LARGE") {
    return { code: INVALID_REQUEST, data: { error_type: "batch_too_large", limit: e.limit, got: e.got } };
  }
  if (e?.code === "TAG_FIELD_CONFLICT") {
    return { code: INVALID_PARAMS, data: { error_type: "tag_field_conflict", tag: e.tag, violations: e.violations ?? [] } };
  }
  if (e?.code === "PARENT_CYCLE") {
    return { code: INVALID_REQUEST, data: { error_type: "parent_cycle", tag: e.tag, cycle: e.cycle ?? [] } };
  }
  if (e?.code === "HISTORY_UNRECOVERABLE") {
    const imported = e.origin === "git-import" && typeof e.import_ix === "number" && Number.isSafeInteger(e.import_ix) && e.import_ix >= 0;
    return { code: INVALID_PARAMS, data: {
      error_type: "history_unrecoverable",
      ...(imported ? { origin: "git-import", import_ix: e.import_ix } : { field: e.field, hint: e.hint }),
    } };
  }
  if (typeof e?.error_type === "string") {
    return {
      code: INVALID_PARAMS,
      data: {
        error_type: e.error_type,
        field: e.field,
        hint: e.hint,
        ...(e.limit !== undefined ? { limit: e.limit } : {}),
        ...(e.got !== undefined ? { got: e.got } : {}),
        ...(e.extension !== undefined ? { extension: e.extension } : {}),
        ...(e.how_to !== undefined ? { how_to: e.how_to } : {}),
        ...(e.size !== undefined ? { size: e.size } : {}),
        ...(e.max_bytes !== undefined ? { max_bytes: e.max_bytes } : {}),
        ...(e.mime_type !== undefined ? { mime_type: e.mime_type } : {}),
      },
    };
  }
  return null;
}

/**
 * Build the caller-visible tool set: core's tools, request-scoped write
 * attribution folded in (`via: "operator"` for the operator bearer, else
 * `"mcp"` — mirrors mcp-tools.ts), filtered to what the caller's scopes permit
 * for THIS vault. A tool the caller can't see in `tools/list` also can't be
 * called (dispatch is against the filtered set) — the primary defense, with the
 * generator's own gating as depth.
 *
 * `attachmentTickets` is ALWAYS passed (this door always wires a provider —
 * see `VaultDO`'s constructor), so `request-attachment-upload`/`-download`
 * are always present, mirroring bun's "tools omitted only when unwired"
 * posture (D10) staying vacuously true here. `noteVisible` is omitted:
 * cloud v1 has no tag-scoped tokens (`rest/tag-scope.ts` — every caller's
 * `scoped_tags` is `null`), so every note/attachment is visible, same as the
 * OTHER visibility predicates this file never wires either.
 */
function visibleTools(
  store: Store,
  vaultName: string,
  auth: AuthResult,
  attachmentTickets: { provider: AttachmentTicketProvider; urlBase: string },
  attachmentBytes?: AttachmentBytesProvider,
): McpToolDef[] {
  // Write-attribution: refine the credential class to the `mcp` channel, but
  // keep `operator` and `nostr:<pubkey>` — each names something more specific
  // than the channel. `nostr:<pubkey>` is the ONLY axis that distinguishes two
  // agents sharing one hub user (`created_by` is that shared user), so
  // flattening it here would reintroduce the bug. Mirrors the bun vault's
  // `src/mcp-tools.ts`. (cloud#277)
  const writeContext = { actor: auth.actor, via: refineMcpVia(auth.via) };
  const tools = generateMcpTools(store, {
    writeContext,
    attachmentTickets: { provider: attachmentTickets.provider, vaultName, urlBase: attachmentTickets.urlBase },
    // read-attachment (the engine adds the tool only when a door wires bytes): ranged R2 reads. Without it an AI
    // app on this door could list a note's files but not look at one, which it can on a box.
    ...(attachmentBytes ? { attachmentBytes: { provider: attachmentBytes } } : {}),
    // T-412: delete-note's erase_history is admin-only, like DELETE /notes/:id/versions. Core refuses it unless this
    // is set. Cloud has no tag-scoped passes, so an admin may also name a note already deleted.
    ...(hasScopeForVault(auth.scopes, vaultName, "admin") ? { eraseHistory: "all" as const } : {}),
  });
  return tools;
}

/** The caller's tools: the 0.9 surface (mcp-09.ts), filtered to what its scopes permit for THIS vault. */
function scopedTools(tools: McpToolDef[], vaultName: string, auth: AuthResult): McpToolDef[] {
  return shape09(tools, vaultName, auth).filter((t) => hasScopeForVault(auth.scopes, vaultName, requiredVerbForTool(t)));
}

/**
 * Adds one outcome to the vault's health counters (T-411, health.ts). The
 * subject is always server-defined: a visible tool's own name, or a fixed
 * label; the outcome never carries a message.
 */
export type HealthRecord = (subject: string, outcome: string) => Promise<void>;
const noRecord: HealthRecord = async () => {};

/**
 * Writes the one server-side line for a crash (error-log.ts, T-420): `tool` is
 * a visible tool's own name or a fixed label, never the caller's string. Only
 * for server-class errors; a refusal the tool makes on purpose is not logged.
 */
export type ToolCrashLog = (tool: string, err: unknown) => void;
const noLog: ToolCrashLog = () => {};

async function handleToolCall(
  id: JsonRpcId,
  params: Record<string, unknown> | undefined,
  tools: McpToolDef[],
  writeGate: McpWriteGate,
  attachmentMintGate: (declaredBytes: number) => Response | null,
  record: HealthRecord = noRecord,
  logCrash: ToolCrashLog = noLog,
): Promise<JsonRpcMessage> {
  const name = typeof params?.name === "string" ? params.name : "";
  const args = (params?.arguments ?? {}) as Record<string, unknown>;
  const tool = tools.find((t) => t.name === name);
  // Unknown / not-visible tool → in-band tool error (not a JSON-RPC error), so
  // callers can't distinguish "hidden admin tool" from "no such tool".
  if (!tool) {
    // The caller's string is never stored: an unknown name counts as one subject.
    await record("mcp:unknown-tool", "unknown_tool");
    return result(id, { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true });
  }
  // From here `name` is one of this vault's own visible tools (server-defined).
  const subject = `mcp:${name}`;
  // attachment-url is listed for readers (download); its upload needs write, checked before the gate answers anything.
  // The visible set is already scope-filtered: a caller with write on this vault sees the old upload mint.
  const writeAllowed = tools.some((t) => t.name === ATTACHMENT_UPLOAD_MINT_TOOL);
  if (name === "attachment-url" && args.action === "upload" && !writeAllowed) {
    await record(subject, "forbidden");
    return result(id, { content: [{ type: "text", text: "Error: Forbidden: attachment-url {action: \"upload\"} needs write on this vault." }], isError: true });
  }
  if (isAttachmentUploadMint(name, args)) {
    // The attachment gate ladder, AT MINT, against the caller's DECLARED
    // size — an agent learns `plan_required`/`attachments_not_included`/
    // `storage_cap_exceeded` before ever curling (D7 of the design). Only
    // runs when `size_bytes` is already a plausible positive number; an
    // absent/invalid one falls through to core's own execute(), which
    // raises the field-validation error — the gate never masks THAT with a
    // confusing cap refusal.
    const sizeBytes = args.size_bytes;
    if (typeof sizeBytes === "number" && Number.isFinite(sizeBytes) && sizeBytes > 0) {
      const blocked = attachmentMintGate(sizeBytes);
      if (blocked) {
        await record(subject, `gate:${blocked.status}`);
        return gateError(id, blocked);
      }
    }
  } else if (isGatedWrite(tool, args)) {
    // The paywall + cap gate — a forward-mutating verb (create/update/prune) gets
    // the SAME frozen-then-cap enforcement the REST write path applies; read-class
    // AND delete-class verbs pass through (REST exempts both). MCP is the flagship
    // write door, so without this an expired (frozen) tenant's connected AI could
    // keep writing forever and a two-meter notes-cap-full vault could keep growing.
    const blocked = writeGate();
    if (blocked) {
      await record(subject, `gate:${blocked.status}`);
      return gateError(id, blocked);
    }
  }
  try {
    const out = await tool.execute(args);
    await record(subject, "ok");
    // A tool may shape its own content blocks (read-attachment returns a real image block); every other tool's
    // result is one text block of JSON. The same rule as the box's MCP layer (parachute-core src/mcp-http.ts).
    const content = tool.resultContent ? tool.resultContent(out) : [{ type: "text" as const, text: JSON.stringify(out, null, 2) }];
    return result(id, { content });
  } catch (err) {
    const domain = mapDomainError(err);
    const message = err instanceof Error ? err.message : "Unknown error";
    // Never the message: the error's class decides (health.ts toolErrorOutcome).
    const outcome = domain ? `domain:${domain.code}` : toolErrorOutcome(err);
    // A server-class fault also leaves one log line (the count alone has no cause).
    if (outcome.startsWith("exception:")) logCrash(name, err);
    await record(subject, outcome);
    if (domain) return rpcError(id, domain.code, message, domain.data);
    return result(id, { content: [{ type: "text", text: `Error: ${message}` }], isError: true });
  }
}

/** The methods whose own code can throw into handleOne's catch (tools/call returns its promise un-awaited). */
const CATCHABLE_METHODS = new Set(["initialize", "tools/list"]);

async function handleOne(
  m: JsonRpcMessage,
  ctx: {
    tools: McpToolDef[];
    vaultName: string;
    description: string | null;
    /** What this connection can read (`connectionReachFor`), for the instructions. */
    reach: string;
    writeGate: McpWriteGate;
    attachmentMintGate: (declaredBytes: number) => Response | null;
    record?: HealthRecord;
    logCrash?: ToolCrashLog;
  },
): Promise<JsonRpcMessage> {
  const record = ctx.record ?? noRecord;
  const logCrash = ctx.logCrash ?? noLog;
  const { id = null, method, params } = m;
  try {
    switch (method) {
      case "initialize": {
        const requested = typeof params?.protocolVersion === "string" ? params.protocolVersion : "";
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : LATEST_PROTOCOL_VERSION;
        await record("mcp:initialize", "ok");
        return result(id, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: `parachute-vault/${ctx.vaultName}`, version: "0.1.0" },
          instructions: serverInstruction(ctx.vaultName, ctx.description, ctx.reach),
        });
      }
      case "tools/list":
        await record("mcp:tools/list", "ok");
        return result(id, {
          tools: ctx.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        });
      case "tools/call":
        return handleToolCall(id, params, ctx.tools, ctx.writeGate, ctx.attachmentMintGate, record, logCrash);
      case "ping":
        return result(id, {});
      default:
        return rpcError(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  } catch (err) {
    // initialize / tools/list threw: always a fault. Named by the fixed method,
    // never the caller's string. (A tools/call rejection outside its tool's
    // execute is not caught here; it propagates to the router's own log.)
    logCrash(CATCHABLE_METHODS.has(method ?? "") ? `rpc:${method}` : "rpc", err);
    await record("mcp:rpc", `exception:${errorClass(err)}`);
    return rpcError(id, INTERNAL_ERROR, err instanceof Error ? err.message : "Internal error");
  }
}

/** A JSON-RPC error with an HTTP status, for the modern era's 400/404 rules (no batches there, so the id is known). */
function modernHttpError(status: number, id: JsonRpcId, code: number, message: string, data?: unknown): Response {
  return new Response(JSON.stringify(rpcError(id, code, message, data)), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** The `_meta` object of a message's params, or undefined. */
function requestMeta(m: JsonRpcMessage): Record<string, unknown> | undefined {
  const meta = m.params?._meta;
  return meta && typeof meta === "object" && !Array.isArray(meta) ? (meta as Record<string, unknown>) : undefined;
}

/**
 * Whether a POST is in the modern (2026-07-28) era: a message declares its
 * version in `_meta`, or the header names a modern version. A legacy client
 * never sends either, so its traffic keeps the legacy path.
 */
function isModernRequest(req: Request, messages: readonly JsonRpcMessage[]): boolean {
  const pv = req.headers.get("mcp-protocol-version");
  if (pv !== null && MODERN_PROTOCOL_VERSIONS.includes(pv)) return true;
  return messages.some((m) => requestMeta(m)?.[META_PROTOCOL_VERSION] !== undefined);
}

/**
 * A mirrored header value (`Mcp-Name`), decoded from the spec's Base64
 * sentinel form `=?base64?…?=` when used. Null when the value is malformed.
 */
function decodeMirroredHeader(value: string): string | null {
  const m = /^=\?base64\?([A-Za-z0-9+/]*={0,2})\?=$/.exec(value);
  if (!m) return value.startsWith("=?base64?") ? null : value;
  try {
    const bytes = Uint8Array.from(atob(m[1]!), (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Validate one modern request against the spec's rules and return the error
 * Response, or null to serve it. Order: the required header, the required
 * `_meta` fields (-32602), header/body agreement (-32020), then the version
 * (-32022, listing every version this door speaks).
 */
function modernRequestError(req: Request, m: JsonRpcMessage): Response | null {
  const id = m.id ?? null;
  const meta = requestMeta(m);
  const version = meta?.[META_PROTOCOL_VERSION];
  const header = req.headers.get("mcp-protocol-version");
  if (typeof version !== "string") {
    return modernHttpError(400, id, INVALID_PARAMS, `Invalid params: _meta["${META_PROTOCOL_VERSION}"] is required`);
  }
  const caps = meta?.[META_CLIENT_CAPABILITIES];
  if (!caps || typeof caps !== "object" || Array.isArray(caps)) {
    return modernHttpError(400, id, INVALID_PARAMS, `Invalid params: _meta["${META_CLIENT_CAPABILITIES}"] is required`);
  }
  if (header === null) {
    return modernHttpError(400, id, HEADER_MISMATCH, "Header mismatch: the MCP-Protocol-Version header is required");
  }
  if (header !== version) {
    return modernHttpError(
      400,
      id,
      HEADER_MISMATCH,
      `Header mismatch: MCP-Protocol-Version header value '${header}' does not match body value '${version}'`,
    );
  }
  const methodHeader = req.headers.get("mcp-method");
  if (methodHeader !== m.method) {
    return modernHttpError(
      400,
      id,
      HEADER_MISMATCH,
      methodHeader === null
        ? "Header mismatch: the Mcp-Method header is required"
        : `Header mismatch: Mcp-Method header value '${methodHeader}' does not match body value '${m.method}'`,
    );
  }
  if (m.method === "tools/call") {
    // A gateway may route or allow-list on Mcp-Name; the body must not run a different tool.
    const raw = req.headers.get("mcp-name");
    const name = raw === null ? null : decodeMirroredHeader(raw);
    if (name === null || name !== m.params?.name) {
      return modernHttpError(
        400,
        id,
        HEADER_MISMATCH,
        raw === null ? "Header mismatch: the Mcp-Name header is required for tools/call" : "Header mismatch: Mcp-Name header value does not match body value",
      );
    }
  }
  if (!MODERN_PROTOCOL_VERSIONS.includes(version)) {
    return modernHttpError(400, id, UNSUPPORTED_PROTOCOL_VERSION, "Unsupported protocol version", {
      supported: ALL_SUPPORTED_VERSIONS,
      requested: version,
    });
  }
  return null;
}

/**
 * Serve one modern-era (2026-07-28) POST. One message per POST (the revision
 * dropped batching); a notification is 202 like the legacy era. The method
 * set is server/discover, tools/list and tools/call; anything else, including
 * initialize and ping (removed in this revision), is 404 -32601. Every result
 * carries `resultType: "complete"` and the server's identity in `_meta`.
 */
const MODERN_METHODS = new Set(["server/discover", "tools/list", "tools/call"]);

/**
 * Everything a modern POST can be answered with before the tool set is built
 * (a batch, a notification, a failed validation, an unknown method), or null
 * to serve it: cheap refusals never pay for visibleTools on the Durable Object.
 */
function modernEarlyResponse(req: Request, raw: unknown, m: JsonRpcMessage): Response | null {
  if (Array.isArray(raw)) {
    return modernHttpError(400, null, INVALID_REQUEST, "Invalid Request: a 2026-07-28 POST carries one JSON-RPC message, not a batch");
  }
  if (!isRequest(m)) return new Response(null, { status: 202 });
  const invalid = modernRequestError(req, m);
  if (invalid) return invalid;
  if (!MODERN_METHODS.has(m.method ?? "")) return modernHttpError(404, m.id ?? null, METHOD_NOT_FOUND, `Method not found: ${m.method}`);
  return null;
}

/** Serve a modern POST that passed {@link modernEarlyResponse}. */
async function handleModern(m: JsonRpcMessage, ctx: Parameters<typeof handleOne>[1]): Promise<Response> {
  const id = m.id ?? null;
  const serverInfo = { name: `parachute-vault/${ctx.vaultName}`, version: "0.1.0" };
  let reply: JsonRpcMessage;
  switch (m.method) {
    case "server/discover":
      reply = result(id, {
        supportedVersions: ALL_SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        instructions: serverInstruction(ctx.vaultName, ctx.description, ctx.reach),
        ttlMs: MODERN_CACHE_TTL_MS,
        cacheScope: "private",
      });
      break;
    case "tools/list": {
      const listed = await handleOne(m, ctx);
      reply = listed.result ? { ...listed, result: { ...(listed.result as object), ttlMs: MODERN_CACHE_TTL_MS, cacheScope: "private" } } : listed;
      break;
    }
    case "tools/call":
      reply = await handleOne(m, ctx);
      break;
    default:
      return modernHttpError(404, id, METHOD_NOT_FOUND, `Method not found: ${m.method}`);
  }
  if (reply.result && typeof reply.result === "object") {
    const r = reply.result as Record<string, unknown>;
    const meta = r._meta && typeof r._meta === "object" ? (r._meta as Record<string, unknown>) : {};
    reply = { ...reply, result: { resultType: "complete", ...r, _meta: { ...meta, [META_SERVER_INFO]: serverInfo } } };
  }
  return new Response(JSON.stringify(reply), { status: 200, headers: { "Content-Type": "application/json" } });
}

/**
 * Handle an MCP request at `/vault/<name>/mcp`. Auth is resolved by the caller
 * (the DO's fetch, same credential order + challenge as REST); `auth` is the
 * validated result. Returns a Web-standard Response.
 */
export async function handleMcp(
  req: Request,
  store: Store,
  vaultName: string,
  auth: AuthResult,
  description: string | null,
  writeGate: McpWriteGate,
  vaultInfo: VaultInfoContext,
  /**
   * The attachment-tickets seam (Wave 1 DO mirror): the DO-storage-backed
   * provider (`attachment-tickets.ts`) + the SAME attachment gate ladder
   * REST's storage upload and the ticket spend route run, applied here at
   * MINT against the caller's declared size (D7 — "an agent learns before
   * curling"). Always supplied by `VaultDO.fetch` (this door always wires a
   * provider); no optionality here keeps `visibleTools` from ever needing
   * to special-case an unwired seam on cloud.
   */
  tickets: {
    provider: AttachmentTicketProvider;
    mintGate: (declaredBytes: number) => Response | null;
    /** Ranged reads of a stored file, for `read-attachment`. Absent in tests that wire no bucket. */
    bytes?: AttachmentBytesProvider;
  },
  record: HealthRecord = noRecord,
  logCrash: ToolCrashLog = noLog,
): Promise<Response> {
  if (req.method === "DELETE") return new Response(null, { status: 200 });
  if (req.method !== "POST") {
    // GET (server-push SSE) + everything else. No server-initiated stream in
    // v1 — a held-open GET stream would pin the DO awake (billing). 405 is
    // spec-legal for a server that offers no SSE stream.
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }),
      { status: 405, headers: { Allow: "POST, DELETE", "Content-Type": "application/json" } },
    );
  }

  const accept = req.headers.get("accept") ?? "";
  if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
    return jsonRpcHttpError(
      406,
      -32000,
      "Not Acceptable: Client must accept both application/json and text/event-stream",
    );
  }
  const ct = req.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) {
    return jsonRpcHttpError(415, -32000, "Unsupported Media Type: Content-Type must be application/json");
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonRpcHttpError(400, PARSE_ERROR, "Parse error: Invalid JSON");
  }

  const rawMessages = Array.isArray(raw) ? raw : [raw];
  const messages: JsonRpcMessage[] = [];
  for (const m of rawMessages) {
    if (!isJsonRpc(m)) return jsonRpcHttpError(400, PARSE_ERROR, "Parse error: Invalid JSON-RPC message");
    messages.push(m);
  }

  // Mcp-Protocol-Version validation (SDK's validateProtocolVersion rule): on any
  // POST that is NOT an initialize, an *unsupported* version header → 400. An
  // absent header is fine (the client defaults to the negotiated version).
  // Initialize negotiates the version in-body, so it is exempt.
  const modern = isModernRequest(req, messages);
  const isInit = messages.some((m) => m.method === "initialize");
  if (!modern && !isInit) {
    const pv = req.headers.get("mcp-protocol-version");
    if (pv !== null && !SUPPORTED_PROTOCOL_VERSIONS.includes(pv)) {
      return jsonRpcHttpError(
        400,
        -32000,
        `Bad Request: Unsupported protocol version: ${pv} (supported versions: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")})`,
      );
    }
  }

  if (modern) {
    const early = modernEarlyResponse(req, raw, messages[0]!);
    if (early) return early;
  }

  const requests = messages.filter(isRequest);
  if (!modern && requests.length === 0) {
    // Notifications / responses only — nothing to answer.
    return new Response(null, { status: 202 });
  }

  // Request-derived origin (X-Forwarded-Host/proto, same as `publicOrigin`
  // elsewhere on this door) — the ticket URL base a mint tool returns, so a
  // curled URL always names the origin the agent actually connected
  // through (the self-healing-under-expose-changes property the design
  // calls for; bun derives it the same way, `mcp-tools.ts`'s `ticketUrlBase`).
  const origin = publicOrigin(req);
  const ticketUrlBase = `${origin.replace(/\/$/, "")}/vault/${vaultName}`;
  const all = visibleTools(store, vaultName, auth, { provider: tickets.provider, urlBase: ticketUrlBase }, tickets.bytes);
  // Wire the server-layer vault-info override onto core's tools (core ships a
  // placeholder execute — "must be configured by the server layer"), then the
  // 0.9 shape and the scope filter. Parity with bun's mcp-tools.ts: override
  // first, so the record surface wraps the real vault-info.
  overrideVaultInfo(all, { vaultName, auth, description, origin, ctx: vaultInfo });
  const tools = scopedTools(all, vaultName, auth);
  // The write stamp (rest/write-stamp.ts): a key with the owner's on-behalf-of grant names who a write is for with
  // `on_behalf_of`; the call runs on the same tools built for that "by", with the token's own scopes.
  applyOnBehalf(tools, auth, (by) => {
    const forBy: AuthResult = { ...auth, actor: by, acts_for: null };
    const twin = visibleTools(store, vaultName, forBy, { provider: tickets.provider, urlBase: ticketUrlBase }, tickets.bytes);
    overrideVaultInfo(twin, { vaultName, auth: forBy, description, origin, ctx: vaultInfo });
    return scopedTools(twin, vaultName, forBy);
  });
  const ctx = { tools, vaultName, description, reach: connectionReachFor(auth, vaultName), writeGate, attachmentMintGate: tickets.mintGate, record, logCrash };
  if (modern) return handleModern(messages[0]!, ctx);
  const responses: JsonRpcMessage[] = [];
  for (const m of requests) responses.push(await handleOne(m, ctx));

  const body = responses.length === 1 ? responses[0] : responses;
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
