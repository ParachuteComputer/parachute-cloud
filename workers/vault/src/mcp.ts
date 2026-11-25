/**
 * MCP endpoint for the Vault DO — Streamable HTTP, stateless per request.
 *
 * The "connect your AI" moment (design §3.1). Ground truth is bun's
 * `parachute-vault/src/mcp-http.ts`, which builds a fresh MCP `Server` +
 * `WebStandardStreamableHTTPServerTransport` per call (stateless: no session
 * id). We reproduce that transport's *exact wire behavior* by hand rather than
 * pulling the SDK into workerd — the SDK's server core drags in ajv (dynamic
 * codegen, blocked under workerd) + a heavy zod/express dep tree, and the
 * stateless surface Claude needs is small. (One SDK piece is imported: the v2
 * SDK's `skillEntry`, which builds each skill's digests and frontmatter for
 * the Skills extension exactly as a box does; mcp-skills.ts. It brings zod,
 * about 125 KB gzipped, and no ajv.) Byte-shape parity with the SDK is
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
 * per-vault scope exactly as bun's mcp-http.ts does. A tool's refusal is the
 * engine's own (core mcp-refusal.ts, T-476): an isError result with
 * structuredContent {error_type, message, ...fields}, as a box answers it, so
 * an agent keys off the same discriminators on either runtime.
 */
import type { Database } from "bun:sqlite";
import { generateMcpTools, type McpToolDef } from "@openparachute/core/src/mcp.js";
import { buildVaultProjection, connectionReach, projectionToMarkdown, resolveTagInheritance, type VaultProjection } from "@openparachute/core/src/vault-projection.js";
import { loadSchemaConfig } from "@openparachute/core/src/schema-defaults.js";
import { listTagRecords } from "@openparachute/core/src/tag-schemas.js";
import type { Store } from "@openparachute/core/src/types.js";
import type { AttachmentTicket, AttachmentTicketProvider } from "@openparachute/core/src/attachment/tickets.js";
import { declaresFilesExtension, MAX_INLINE_ATTACHMENT_BYTES, schemaForClient } from "@openparachute/core/src/attachment/inline.js";
import type { Attachment } from "@openparachute/core/src/types.js";
import { UploadRefused } from "./attachment-tickets.js";
import type { AttachmentBytesProvider } from "@openparachute/core/src/attachment/bytes-provider.js";
import { hasScopeForVault, refineMcpVia, type AuthResult, type VaultVerb } from "./auth.js";
import { applyOnBehalf } from "./rest/write-stamp.js";
import { tagScopeFor, tagVisibleInScope } from "./rest/tag-scope.js";
import { getVaultMap, getVaultStats } from "@openparachute/core/src/notes.js";
import { applyScopeWrappers, idVisibility, NARROWED_TOOLS, scopeVisibility } from "./mcp-tag-scope.js";
import { NOTE_TOOL_NAMES, recordWords } from "@openparachute/core/src/mcp-records.js";
import { recordErrorData, shapeRecordSurface } from "@openparachute/core/src/mcp-surface.js";
import { latestRelease, newerRelease, withRefusalDocs, withWarningDocs, type DocsContext } from "@openparachute/core/src/docs-tool.js";
import { toolAnnotations, type McpLevel } from "@openparachute/core/src/mcp-annotations.js";
import { mcpCallResult } from "@openparachute/core/src/mcp-result.js";
import {
  internalRefusal,
  refusal,
  refusalOfError,
  refusalOfReply,
  refusalResult,
  unknownToolRefusal,
  type McpRefusal,
} from "@openparachute/core/src/mcp-refusal.js";
import { errorClass, refusalOutcome, toolErrorOutcome } from "./health.js";
import { SKILL_METHODS, SKILLS_EXTENSION_ID, vaultSkillMethods } from "./mcp-skills.js";

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
 * The frozen-tenant gate by (tool, action), every tool this door can list (T-456). All MCP is POST JSON-RPC, so the
 * paywall can't live at the HTTP layer: each call is classed here before it runs, the same way REST classes a
 * request by method.
 *
 *   - `notes`: a forward write (create, update, rename, merge, prune, migrate, a description change). It meets the
 *     REST POST/PATCH/PUT gate: frozen → 402 `plan_required`, the notes meter full → 413 `storage_cap_exceeded`.
 *   - `attachments`: the upload mint (`request-attachment-upload`, `attachment-url {action: "upload"}`). It meets the
 *     attachment meter's own ladder at mint (frozen → `attachments_not_included` → the attachment cap), as REST's
 *     storage upload and the ticket spend route do (caps.ts, attachment-tickets.ts); see handleToolCall.
 *   - `open`: a read, or a delete. REST leaves GET and DELETE untouched: a frozen or full vault must always be
 *     readable, exportable and able to delete its way back down.
 *
 * A tool that dispatches on `action` is classed per action (manage-types defaults to `update`, as the engine does).
 * vault-info is a read unless the call carries `description`. A tool or action this table doesn't name is gated as
 * `notes`: a new write can't slip past the paywall, and test/write-gate.test.ts fails until it is named here.
 */
export type WriteGateClass = "notes" | "attachments" | "open";
export const WRITE_GATES: Readonly<Record<string, WriteGateClass | Readonly<Record<string, WriteGateClass>>>> = {
  "query-records": "open",
  "create-record": "notes",
  "update-record": "notes",
  "delete-record": "open",
  "list-types": "open",
  doctor: "open",
  docs: "open", // T-476: reads the docs site, nothing of the vault: a frozen vault's AI can still read how to fix it
  "read-attachment": "open",
  "attachment-url": { upload: "attachments", download: "open" },
  "manage-types": { update: "notes", rename: "notes", merge: "notes", delete: "open", prune: "notes", migrate: "notes" },
  "query-notes": "open",
  "create-note": "notes",
  "update-note": "notes",
  "delete-note": "open",
  "list-tags": "open",
  "find-path": "open",
  "update-tag": "notes",
  "rename-tag": "notes",
  "merge-tags": "notes",
  "delete-tag": "open",
  "prune-schema": "notes",
  "request-attachment-upload": "attachments",
  "request-attachment-download": "open",
  // T-476 (next #444): a file sent in the call, gated like the mint on the file's declared size.
  "add-attachment": "attachments",
};

/** Which gate a call meets (see {@link WRITE_GATES}). */
const GATE_CLASSES: ReadonlySet<unknown> = new Set<WriteGateClass>(["notes", "attachments", "open"]);
export function writeGateFor(name: string, args: Record<string, unknown>): WriteGateClass {
  if (name === "vault-info") return args.description !== undefined ? "notes" : "open";
  // Own properties only, and only one of the three classes: `constructor` or `__proto__` must never read as open.
  const entry = Object.hasOwn(WRITE_GATES, name) ? WRITE_GATES[name] : undefined;
  if (typeof entry === "string") return GATE_CLASSES.has(entry) ? entry : "notes";
  if (!entry || typeof entry !== "object") return "notes";
  const action = args.action ?? (name === "manage-types" ? "update" : undefined);
  // attachment-url with no action: the surface refuses it before anything runs, so it meets no meter; any other
  // unnamed or non-string action is gated.
  if (action === undefined && name === "attachment-url") return "open";
  const cls = typeof action === "string" && Object.hasOwn(entry, action) ? entry[action] : undefined;
  return GATE_CLASSES.has(cls) ? (cls as WriteGateClass) : "notes";
}

/** The upload mint's tool name before 0.9, still listed. */
const ATTACHMENT_UPLOAD_MINT_TOOL = "request-attachment-upload";
/** T-476 (next #444): a small file sent in the call itself (core's add-attachment), for an AI that can't reach a ticket URL. */
const ATTACHMENT_INLINE_TOOL = "add-attachment";

/**
 * A REST cap/frozen Response (402 `plan_required`, 413 `storage_cap_exceeded`, 403 `attachments_not_included`) as the
 * tool's refusal (one way to refuse, T-476): the REST body's `error_type`, `message` and fields, so an agent keys off
 * the SAME `error_type` on either door. Reusing the REST body (never a hand-rolled shape) keeps MCP and REST from
 * drifting.
 */
async function gateRefusal(blocked: Response): Promise<McpRefusal> {
  const body = await blocked.json().catch(() => null);
  return refusalOfReply(body) ?? refusal("forbidden", "This write is not permitted.");
}

/** A record tool's refusal in record words, as a box says it (core packages/vault/src/mcp-http.ts recordRefusal, T-407). */
function recordRefusal(r: McpRefusal): McpRefusal {
  const { error_type, message, ...rest } = r;
  return { error_type, message, ...recordErrorData(rest) };
}

/**
 * The connect-time server instruction: the same brief a box sends (core `projectionToMarkdown`, from the vault's own
 * projection, in record words), so a model connecting here is told the same things: the vault's name and addresses,
 * where to start, its types and indexed fields, how to query, how files move, and how to script it. Only the
 * scripting line is this door's own: keys are made in the account here, not with a box's `parachute` command.
 *
 * `description` is the vault's own text. cloud#87: a non-string one (a vault poisoned before both write doors checked
 * the type) degrades to no description inside the engine's renderer, so the vault can still be connected to and
 * repaired; `initialize` is the first frame, and a throw here would leave the AI no way in.
 *
 * `reach` (0.9.1, SPEC §3.4) is the engine's sentence for what this connection can read (`connectionReachFor`), on
 * the line under the one that names the vault.
 */
export function serverInstruction(
  vaultName: string,
  description: string | null,
  reach: string | undefined,
  projection: VaultProjection,
  attachments: { readEnabled: boolean; addEnabled?: boolean } = { readEnabled: true },
  /** Where the docs are and the version (T-476, src/docs.ts); omitted or no origin: no Docs line. */
  docs?: DocsContext,
): string {
  return projectionToMarkdown({
    vaultName,
    description,
    projection,
    // Addresses relative to the origin the client connected through: one vault answers on several hosts (u., my.,
    // the root /mcp), and the brief must be the same on each (test/root-mcp.test.ts). vault-info names the full URLs.
    coordinates: { hubOrigin: "", hubOriginKnown: false },
    // This door always wires an AttachmentTicketProvider (VaultDO's constructor); read-attachment when bytes are wired.
    attachments: { ticketsEnabled: true, readEnabled: attachments.readEnabled, ticketTool: "attachment-url", addEnabled: attachments.addEnabled === true },
    words: recordWords,
    ...(reach ? { reach } : {}),
    scripting:
      `For a script or cron job, make a key for this vault in your account (\`POST /account/keys {name, vault: "${vaultName}", can: "read"}\`, ` +
      `or the app's keys page) and call the REST API at \`<hub-origin>/vault/${vaultName}/api/...\`; guide: https://parachute.computer/docs/build/scripts/`,
    // T-476: the Docs line names the tool and this door's version, and "X is out" from the site's /latest.json as last
    // read (in the background: a connect never waits on the site).
    docs: docs?.origin ? { origin: docs.origin, version: docs.version, newer: newerRelease(docs.version, latestRelease(docs.origin).value) } : null,
  });
}

/**
 * The vault's projection for the connect-time brief. For a typed key (T-476) only its own types and the fields they
 * declare, counts over the records it can see, and no guide pointer or query hints (they could name what it can't
 * see): the box's filterProjectionByScope, recomputing map and stats through the key's types.
 */
export function projectionFor(store: Store, auth: AuthResult): VaultProjection {
  const projection = buildVaultProjection(store.db as never, { includeStats: true });
  if (!auth.scoped_tags) return projection;
  const scope = tagScopeFor(store, auth.scoped_tags);
  const visible = (t: string) => tagVisibleInScope(t, scope.allowed, scope.raw);
  const tagFilter = new Set(scope.allowed ?? []);
  for (const r of store.db.prepare("SELECT DISTINCT tag_name FROM note_tags").all() as { tag_name: string }[]) {
    if (visible(r.tag_name)) tagFilter.add(r.tag_name);
  }
  const filter = { tagFilter: [...tagFilter] };
  const { getting_started: _guide, ...rest } = projection;
  return {
    ...rest,
    tags: projection.tags.filter((t) => visible(t.name)),
    indexed_fields: projection.indexed_fields.map((f) => ({ ...f, tags: f.tags.filter(visible) })).filter((f) => f.tags.length > 0),
    query_hints: [],
    map: getVaultMap(store.db as never, filter),
    stats: getVaultStats(store.db as never, filter),
  };
}

/**
 * The types vault-guide pages (skill-files.ts `vaultGuideFiles` reads only a projection's `tags`), built as
 * buildVaultProjection builds its `tags` and narrowed as {@link projectionFor} narrows them for a typed key, but without
 * the vault map and stats: those count over every record, and a skills request (claude.ai lists skills on every
 * connect) must not pay a scan of the vault in rows read. test/mcp-skills.test.ts holds the guide equal to the one
 * the full projection makes.
 */
export function guideTagsFor(store: Store, auth: AuthResult): VaultProjection["tags"] {
  const db = store.db as never;
  const resolved = loadSchemaConfig(db);
  const tags: VaultProjection["tags"] = [];
  for (const r of listTagRecords(db)) {
    const hasOwnSchema = (r.description !== undefined && r.description !== null) || (r.fields != null && Object.keys(r.fields).length > 0);
    if (!hasOwnSchema) continue;
    const { effective_parents, effective_fields } = resolveTagInheritance(resolved, r.tag);
    tags.push({
      name: r.tag,
      description: r.description ?? null,
      parents: r.parent_names ?? [],
      effective_parents,
      fields: r.fields ?? null,
      effective_fields,
      relationships: r.relationships ?? null,
    });
  }
  if (!auth.scoped_tags) return tags;
  const scope = tagScopeFor(store, auth.scoped_tags);
  return tags.filter((t) => tagVisibleInScope(t.name, scope.allowed, scope.raw));
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
 * Auto hybrid search on cloud when a vault hasn't chosen (core's HYBRID_AUTO_DEFAULT is on for a box): off. Core #120
 * (vectors read by key) and #124 (each batch scored as it is read) fixed the row count and the memory: on staging at
 * core 909843f a 24,000-note vault answers every question with no error. But a question still costs a Workers AI embed
 * and a scan that grows with the vault: auto-on median 389-549 ms at 10,000 notes and 664 ms at 24,000, against
 * 57-70 ms off (T-456, 11-14, p09-lock evidence/hybrid/2026-11-14). The gate for turning it on was under ~300 ms at
 * 10,000 notes, so it stays off; a vault's admin can turn it on (PATCH /api/vault {config: {search: {auto_hybrid}}}).
 */
export const CLOUD_HYBRID_AUTO_DEFAULT = false;

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
  /** This vault's own `search.auto_hybrid` (rest/vault.ts), read at each search; cloud's default when unset is off
   *  ({@link CLOUD_HYBRID_AUTO_DEFAULT}). */
  hybridAuto?: () => boolean | null | undefined;
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
 * through the #82 write gate at the dispatch layer (`writeGateFor` treats
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
    // `help` is answered by the engine's 0.9 surface (shapeRecordSurface) before this runs.
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
      // writeGateFor/handleToolCall — so this only guards SCOPE.)
      //
      // The REST door matches since T-419 (audit L3-01): `PATCH /api/vault` with a `description` needs admin too
      // (vault-do.ts), so this check is a real boundary, not an advisory one.
      // Tagged `insufficient_scope`, as a box's is since T-476 (core packages/vault/src/mcp-tools.ts), so it is a
      // refusal, not an `internal_error`.
      if (!hasScopeForVault(auth.scopes, vaultName, "admin")) {
        throw Object.assign(
          new Error(
            `Forbidden: updating the vault description requires the 'vault:admin' scope (or 'vault:${vaultName}:admin'). Granted scopes: ${auth.scopes.join(" ") || "(none)"}.`,
          ),
          { error_type: "insufficient_scope" },
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
      // `error_type` error, which the engine's refusal mapping (core
      // mcp-refusal.ts refusalOfError) answers as an isError refusal with its
      // fields. That is the SAME shape core's own validation leaves take
      // (core/src/mcp.ts `structuredError`, e.g. update-tag's
      // `invalid_parent_names`); no new error family, and deliberately NOT a
      // bare throw, which would answer `internal_error`.
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
  attachmentTickets: { provider: AttachmentTicketProvider; urlBase: string; storeUpload?: (ticket: AttachmentTicket, bytes: Uint8Array) => Promise<Attachment> },
  attachmentBytes?: AttachmentBytesProvider,
  hybridAuto?: () => boolean | null | undefined,
): McpToolDef[] {
  // Write-attribution: refine the credential class to the `mcp` channel, but
  // keep `operator` and `nostr:<pubkey>` — each names something more specific
  // than the channel. `nostr:<pubkey>` is the ONLY axis that distinguishes two
  // agents sharing one hub user (`created_by` is that shared user), so
  // flattening it here would reintroduce the bug. Mirrors the bun vault's
  // `src/mcp-tools.ts`. (cloud#277)
  const writeContext = { actor: auth.actor, via: refineMcpVia(auth.via) };
  // A typed key (T-476): its types are the session's scope. The engine narrows what it can (search, rollups, links,
  // near walks, if_exists, references, files); mcp-tag-scope.ts wraps the rest; scopedTools lists only what is narrowed.
  const scope = auth.scoped_tags ? tagScopeFor(store, auth.scoped_tags) : null;
  const vis = scope ? scopeVisibility(scope) : undefined;
  const idVis = scope ? idVisibility(store.db as never, scope) : undefined;
  const toolOpts: Parameters<typeof generateMcpTools>[1] = {
    writeContext,
    ...(vis && idVis
      ? {
          expandVisibility: vis,
          nearTraversable: idVis,
          ifExistsVisible: vis,
          aggregateVisibility: vis,
          // `searchVisibility` scopes the engine's cursor paging (its watermark follows visible records only). A
          // search can't take it: the engine ranks a visible-only search inside a temporary FTS table, which a
          // Durable Object's SQLite refuses; so a typed key's search runs on a second tool set without it, and
          // query-notes' wrapper filters its results (mcp-tag-scope.ts, T-476 review r3 and the check after it).
          searchVisibility: vis,
          resolveVisibility: vis,
          ambiguityVisible: idVis,
          mayChangePublished: () => tagVisibleInScope("publish", scope!.allowed, scope!.raw),
        }
      : {}),
    // 0.9.3 auto hybrid: a question-shaped search with no search_mode also asks the meaning index (a Workers AI embed
    // call plus a batched scan of the candidates' vectors in the vault's DO). Off on cloud unless the vault turns it on
    // (CLOUD_HYBRID_AUTO_DEFAULT, measured there).
    hybridAuto: () => hybridAuto?.() ?? CLOUD_HYBRID_AUTO_DEFAULT,
    // T-476: only an admin key adds or changes a skill (core skills.ts); a typed key never, as on a box (mcp-tools.ts).
    maySkills: hasScopeForVault(auth.scopes, vaultName, "admin") && !(auth.scoped_tags && auth.scoped_tags.length > 0),
    attachmentTickets: {
      provider: attachmentTickets.provider,
      vaultName,
      urlBase: attachmentTickets.urlBase,
      // add-attachment (T-476): bytes sent in the call, stored by the ticket spend's own writer (R2, meter, row).
      ...(attachmentTickets.storeUpload ? { storeUpload: attachmentTickets.storeUpload } : {}),
      // A typed key's ticket names its grant and scope, and is spent only while both still hold (attachment-tickets.ts).
      ...(vis ? { noteVisible: vis, scopedTags: auth.scoped_tags! } : {}),
      ...(auth.grant ? { grant: auth.grant } : {}),
    },
    // read-attachment (the engine adds the tool only when a door wires bytes): ranged R2 reads. Without it an AI
    // app on this door could list a note's files but not look at one, which it can on a box.
    ...(attachmentBytes ? { attachmentBytes: { provider: attachmentBytes, ...(vis ? { noteVisible: vis } : {}) } } : {}),
    // T-412: delete-note's erase_history is admin-only, like DELETE /notes/:id/versions. Core refuses it unless this
    // is set. Cloud has no tag-scoped passes, so an admin may also name a note already deleted.
    ...(hasScopeForVault(auth.scopes, vaultName, "admin") ? { eraseHistory: "all" as const } : {}),
  };
  const tools = generateMcpTools(store, toolOpts);
  if (scope) {
    const searchOnly = generateMcpTools(store, { ...toolOpts, searchVisibility: undefined }).find((t) => t.name === "query-notes");
    applyScopeWrappers(tools, store, scope, !!auth.grant, searchOnly ? (p) => Promise.resolve(searchOnly.execute(p)) : undefined);
  }
  return tools;
}

/**
 * The caller's tools: the engine's 0.9 surface (core mcp-surface.ts, the same one a box builds), filtered to what its
 * scopes permit for THIS vault. Cloud has no in-vault token tool and no tag-scoped passes, so it passes neither.
 */
function scopedTools(store: Store, tools: McpToolDef[], vaultName: string, auth: AuthResult, countName?: NameCount, docs?: DocsContext): McpToolDef[] {
  const shaped = shapeRecordSurface(tools, {
    // T-476: the engine's `docs` tool, for this door's version and docs origin (none when the door has no docs).
    docs: docs?.origin ? { origin: docs.origin, version: docs.version } : null,
    db: store.db as unknown as Parameters<typeof shapeRecordSurface>[1]["db"],
    vaultName,
    hasVerb: (verb) => hasScopeForVault(auth.scopes, vaultName, verb),
    // T-476 (core #134): a type this session defines records its write stamp, the same two facts its record writes
    // carry, so write access may later add fields to a type it made (core type-write.ts). (The engine lists
    // manage-types to any write session; the stamp is what makes "a type you made" hold.)
    writer: { by: auth.actor, via: refineMcpVia(auth.via) },
    // A typed key: the record surface's own type lookups see only its types (and it is refused manage-types anyway).
    ...(auth.scoped_tags
      ? (() => {
          const sc = tagScopeFor(store, auth.scoped_tags!);
          return { tagVisible: async () => (t: string) => tagVisibleInScope(t, sc.allowed, sc.raw) };
        })()
      : {}),
    // Old and new names, as a box counts them (`mcp <tool>`, `mcp <tool> <param>`): the DO adds the client.
    ...(countName ? { onUse: (name: string, kind: "old" | "new") => countName(`mcp ${name}`, kind) } : {}),
  });
  return shaped.filter((t) => hasScopeForVault(auth.scopes, vaultName, requiredVerbForTool(t)) && (!auth.scoped_tags || NARROWED_TOOLS.has(t.name)));
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

/** Counts one use of an old or new name (health.ts NameCounts); the DO knows the request's client. */
export type NameCount = (name: string, kind: "old" | "new") => void;
const noLog: ToolCrashLog = () => {};

async function handleToolCall(
  id: JsonRpcId,
  params: Record<string, unknown> | undefined,
  tools: McpToolDef[],
  writeGate: McpWriteGate,
  attachmentMintGate: (declaredBytes: number) => Response | null,
  record: HealthRecord = noRecord,
  logCrash: ToolCrashLog = noLog,
  /** The connection's level: what an unknown tool's refusal says the caller has (T-476). */
  level?: McpLevel,
  docs?: DocsContext,
): Promise<JsonRpcMessage> {
  const name = typeof params?.name === "string" ? params.name : "";
  const args = (params?.arguments ?? {}) as Record<string, unknown>;
  const tool = tools.find((t) => t.name === name);
  // One way to refuse (T-476, core mcp-refusal.ts): every refusal below is an isError result with structuredContent
  // {error_type, message, ...}, never a JSON-RPC error; only the protocol's own errors stay those.
  // Unknown / not-visible tool → `unknown_tool`, so callers can't distinguish "hidden admin tool" from "no such tool".
  if (!tool) {
    // The caller's string is never stored: an unknown name counts as one subject.
    await record("mcp:unknown-tool", "unknown_tool");
    return result(id, refusalResult(unknownToolRefusal(name, level)));
  }
  // From here `name` is one of this vault's own visible tools (server-defined).
  const subject = `mcp:${name}`;
  // attachment-url is listed for readers (download); its upload needs write, checked before the gate answers anything.
  // The visible set is already scope-filtered: a caller with write on this vault sees the old upload mint.
  const writeAllowed = tools.some((t) => t.name === ATTACHMENT_UPLOAD_MINT_TOOL);
  if (name === "attachment-url" && args.action === "upload" && !writeAllowed) {
    await record(subject, refusalOutcome("insufficient_scope"));
    return result(id, refusalResult(refusal("insufficient_scope", "Forbidden: attachment-url {action: \"upload\"} needs write on this vault.")));
  }
  const gate = writeGateFor(name, args);
  if (gate === "attachments") {
    // The attachment gate ladder, AT MINT, against the caller's DECLARED
    // size — an agent learns `plan_required`/`attachments_not_included`/
    // `storage_cap_exceeded` before ever curling (D7 of the design). Only
    // runs when `size_bytes` is already a plausible positive number; an
    // absent/invalid one falls through to core's own execute(), which
    // raises the field-validation error — the gate never masks THAT with a
    // confusing cap refusal.
    // add-attachment declares its size on the file (FileInput `size`); the store re-runs the gate on the bytes. A file
    // over the inline cap, or a size that isn't a whole number, is left to core, whose refusal names it.
    const sizeBytes = name === ATTACHMENT_INLINE_TOOL ? (args.file as { size?: unknown } | undefined)?.size : args.size_bytes;
    const overInline = name === ATTACHMENT_INLINE_TOOL && (!Number.isInteger(sizeBytes) || (sizeBytes as number) > MAX_INLINE_ATTACHMENT_BYTES);
    if (typeof sizeBytes === "number" && Number.isFinite(sizeBytes) && sizeBytes > 0 && !overInline) {
      const blocked = attachmentMintGate(sizeBytes);
      if (blocked) {
        await record(subject, `gate:${blocked.status}`);
        return result(id, refusalResult(await gateRefusal(blocked)));
      }
    }
  } else if (gate === "notes") {
    // The paywall + cap gate — a forward-mutating verb (create/update/prune) gets
    // the SAME frozen-then-cap enforcement the REST write path applies; read-class
    // AND delete-class verbs pass through (REST exempts both). MCP is the flagship
    // write door, so without this an expired (frozen) tenant's connected AI could
    // keep writing forever and a two-meter notes-cap-full vault could keep growing.
    const blocked = writeGate();
    if (blocked) {
      await record(subject, `gate:${blocked.status}`);
      return result(id, refusalResult(await gateRefusal(blocked)));
    }
  }
  try {
    const out = await tool.execute(args);
    // A tool may shape its own content blocks (read-attachment returns a real image block); every other tool's
    // result is one text block of JSON, plus `structuredContent` where ChatGPT would read it as `{}` (a note by id;
    // T-456, core mcp-result.ts), and a refusal said as data (`{error, error_type}`) is answered as a refusal. The
    // same call as the box's MCP layer (parachute-core src/mcp-http.ts).
    // T-476: a warning with a fix page (a type that isn't there) names it, as a box's does.
    const answer = mcpCallResult(tool, withWarningDocs(out, docs));
    // Counted by the type the tool's reply named itself, or its `error` when that is one bare word (manage-keys'
    // `invalid_request`); never a word made from a message (refusalOutcome takes only a bare word).
    const said = out as { error_type?: unknown; error?: unknown };
    await record(subject, answer.isError ? refusalOutcome(said.error_type ?? said.error) : "ok");
    return result(id, answer);
  } catch (err) {
    // A storage gate that refused inside the tool (add-attachment's store, T-476): the same answer as at the call's gate.
    if (err instanceof UploadRefused) {
      await record(subject, `gate:${err.status}`);
      return result(id, refusalResult(refusalOfReply(err.gateBody) ?? refusal("forbidden", err.message)));
    }
    // A refusal the engine tagged: the box's own mapping (core mcp-refusal.ts refusalOfError), counted by its type.
    const refused = refusalOfError(err);
    if (refused) {
      await record(subject, refusalOutcome(refused.error_type));
      // As a box answers: a record tool's refusal is in record words (`record_id`, the record hints).
      return result(id, refusalResult(NOTE_TOOL_NAMES[name] ? recordRefusal(refused) : refused));
    }
    // Nobody tagged it: `internal_error`, as a box answers. Never the message: the error's class decides the count
    // (health.ts toolErrorOutcome), and a server-class fault also leaves one log line (the count alone has no cause).
    const outcome = toolErrorOutcome(err);
    if (outcome.startsWith("exception:")) logCrash(name, err);
    await record(subject, outcome);
    return result(id, refusalResult(internalRefusal(err)));
  }
}

/** The methods whose own code can throw into handleOne's catch (tools/call returns its promise un-awaited). */
const CATCHABLE_METHODS = new Set(["initialize", "tools/list"]);

async function handleOne(
  m: JsonRpcMessage,
  ctx: {
    tools: McpToolDef[];
    /** The connection's level on this vault, for the tools' MCP annotations (two tools' hints follow it). */
    level: McpLevel;
    vaultName: string;
    description: string | null;
    /** The connect-time brief (`serverInstruction`), built only when a client asks for it. */
    instructions: () => string;
    writeGate: McpWriteGate;
    attachmentMintGate: (declaredBytes: number) => Response | null;
    record?: HealthRecord;
    logCrash?: ToolCrashLog;
    /** T-476: every refusal names the page with its fix (core docs-tool.ts withRefusalDocs). */
    docs?: DocsContext;
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
          instructions: ctx.instructions(),
        });
      }
      case "tools/list":
        await record("mcp:tools/list", "ok");
        return result(id, {
          // T-456: each tool says what it does to the vault (core mcp-annotations.ts, the box's table), so a client can
          // tell a read from a change: ChatGPT's "Allow read-only tools" otherwise asks before every read.
          // T-476: a file argument is marked `x-mcp-file` only for a client that declared the file-transfer extension,
          // as a box lists it (core src/mcp-http.ts).
          tools: ctx.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: schemaForClient(t.inputSchema, declaresFilesExtension(params?._meta)), annotations: toolAnnotations(t.name, ctx.level) })),
        });
      case "tools/call":
        // T-476: every refusal (the tool's, the gate's, an unknown tool's) carries `docs`, as a box's does. Returned
        // un-awaited, as before: a rejection still unwinds past this try (CATCHABLE_METHODS).
        return handleToolCall(id, params, ctx.tools, ctx.writeGate, ctx.attachmentMintGate, record, logCrash, ctx.level, ctx.docs).then((answered) => {
          const r = answered.result as { isError?: unknown } | undefined;
          return r && r.isError === true ? { ...answered, result: withRefusalDocs(r as never, ctx.docs) } : answered;
        });
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
  // A gateway may route or allow-list on Mcp-Name; the body must not run a different tool or read a different
  // resource (the SDK's table: tools/call mirrors params.name, resources/read params.uri, as a box checks them).
  const mirrored = m.method === "tools/call" ? m.params?.name : m.method === "resources/read" && typeof m.params?.uri === "string" ? m.params.uri : undefined;
  if (m.method === "tools/call" || mirrored !== undefined) {
    const raw = req.headers.get("mcp-name");
    const name = raw === null ? null : decodeMirroredHeader(raw);
    if (name === null || name !== mirrored) {
      return modernHttpError(
        400,
        id,
        HEADER_MISMATCH,
        raw === null ? `Header mismatch: the Mcp-Name header is required for ${m.method}` : "Header mismatch: Mcp-Name header value does not match body value",
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
 * set is server/discover, tools/list and tools/call, and the Skills extension's
 * (mcp-skills.ts: skills/list, skills/get, resources/list,
 * resources/templates/list, resources/read; T-476, as a box serves them);
 * anything else, including initialize and ping (removed in this revision), is
 * 404 -32601. Every result carries `resultType: "complete"` and the server's
 * identity in `_meta`.
 */
const MODERN_METHODS = new Set(["server/discover", "tools/list", "tools/call", ...SKILL_METHODS]);

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
async function handleModern(
  m: JsonRpcMessage,
  ctx: Parameters<typeof handleOne>[1] & { skills: ReturnType<typeof vaultSkillMethods> },
): Promise<Response> {
  const id = m.id ?? null;
  const serverInfo = { name: `parachute-vault/${ctx.vaultName}`, version: "0.1.0" };
  let reply: JsonRpcMessage;
  switch (m.method) {
    case "server/discover":
      reply = result(id, {
        supportedVersions: ALL_SUPPORTED_VERSIONS,
        // The Skills extension, declared as a box declares it; its SKILL.md files are resources too. No `listChanged`:
        // this door sends no notifications (no server-push stream, see handleMcp's GET).
        capabilities: { tools: {}, resources: {}, extensions: { [SKILLS_EXTENSION_ID]: {} } },
        instructions: ctx.instructions(),
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
    default: {
      if (!SKILL_METHODS.has(m.method ?? "")) return modernHttpError(404, id, METHOD_NOT_FOUND, `Method not found: ${m.method}`);
      // From here the method is one of SKILL_METHODS (server-defined), so it may name the health subject.
      const subject = `mcp:${m.method}`;
      try {
        const answer = await ctx.skills(m.method!, m.params);
        await ctx.record?.(subject, "error" in answer ? refusalOutcome("invalid_params") : "ok");
        reply = "error" in answer ? { jsonrpc: "2.0", id, error: answer.error } : result(id, answer.result);
      } catch (err) {
        ctx.logCrash?.(`rpc:${m.method}`, err);
        await ctx.record?.(subject, `exception:${errorClass(err)}`);
        reply = rpcError(id, INTERNAL_ERROR, "Internal error");
      }
      break;
    }
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
    /** Store bytes sent in the call (`add-attachment`, T-476), as a spent upload ticket stores them. Absent: no tool. */
    storeUpload?: (ticket: AttachmentTicket, bytes: Uint8Array) => Promise<Attachment>;
  },
  record: HealthRecord = noRecord,
  logCrash: ToolCrashLog = noLog,
  countName?: NameCount,
  /** Where the docs are and the version this door runs (T-476, src/docs.ts): the `docs` tool, the brief's line, and
   *  `docs` on every refusal. Omitted: none of them. */
  docs?: DocsContext,
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
  const ticketSeam = { provider: tickets.provider, urlBase: ticketUrlBase, storeUpload: tickets.storeUpload };
  const all = visibleTools(store, vaultName, auth, ticketSeam, tickets.bytes, vaultInfo.hybridAuto);
  // Wire the server-layer vault-info override onto core's tools (core ships a
  // placeholder execute — "must be configured by the server layer"), then the
  // 0.9 shape and the scope filter. Parity with bun's mcp-tools.ts: override
  // first, so the record surface wraps the real vault-info.
  overrideVaultInfo(all, { vaultName, auth, description, origin, ctx: vaultInfo });
  // A skills request reads through query-records, which the client never called: it counts no name use.
  const skillsCall = modern && SKILL_METHODS.has(messages[0]?.method ?? "");
  const tools = scopedTools(store, all, vaultName, auth, skillsCall ? undefined : countName, docs);
  // The write stamp (rest/write-stamp.ts): a key with the owner's on-behalf-of grant names who a write is for with
  // `on_behalf_of`; the call runs on the same tools built for that "by", with the token's own scopes.
  applyOnBehalf(tools, auth, (by) => {
    const forBy: AuthResult = { ...auth, actor: by, acts_for: null };
    const twin = visibleTools(store, vaultName, forBy, ticketSeam, tickets.bytes, vaultInfo.hybridAuto);
    overrideVaultInfo(twin, { vaultName, auth: forBy, description, origin, ctx: vaultInfo });
    return scopedTools(store, twin, vaultName, forBy, countName, docs);
  });
  const instructions = () =>
    serverInstruction(vaultName, description, connectionReachFor(auth, vaultName), projectionFor(store, auth), {
      readEnabled: tickets.bytes !== undefined,
      // As a box says it (core src/mcp-tools.ts): the brief names add-attachment where this connection lists it.
      addEnabled: tools.some((t) => t.name === ATTACHMENT_INLINE_TOOL),
    }, docs);
  // The connection's level here (cloud has no tag-scoped passes, so an admin scope is a vault-wide admin).
  const level: McpLevel = hasScopeForVault(auth.scopes, vaultName, "admin") ? "admin" : hasScopeForVault(auth.scopes, vaultName, "write") ? "write" : "read";
  const ctx = { tools, level, vaultName, description, instructions, writeGate, attachmentMintGate: tickets.mintGate, record, logCrash, docs };
  if (modern) {
    // The Skills extension reads through this connection's own query-records and projection, so a key sees only the
    // skill records it could read anyway, and only this vault's (the store is this Durable Object's).
    const skills = vaultSkillMethods({
      vaultName,
      guideTags: () => guideTagsFor(store, auth),
      queryRecords: tools.find((t) => t.name === "query-records"),
    });
    return handleModern(messages[0]!, { ...ctx, skills });
  }
  const responses: JsonRpcMessage[] = [];
  for (const m of requests) responses.push(await handleOne(m, ctx));

  const body = responses.length === 1 ? responses[0] : responses;
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
