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
import { buildVaultProjection, attachmentsInstructionBlock } from "@openparachute/core/src/vault-projection.js";
import type { Store } from "@openparachute/core/src/types.js";
import type { AttachmentTicketProvider } from "@openparachute/core/src/attachment/tickets.js";
import { hasScopeForVault, type AuthResult, type VaultVerb } from "./auth.js";

// Transcribed from the SDK's types.js so negotiation matches byte-for-byte.
const LATEST_PROTOCOL_VERSION = "2025-11-25";
const SUPPORTED_PROTOCOL_VERSIONS = [
  LATEST_PROTOCOL_VERSION,
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
];

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
const DELETE_CLASS_TOOLS = new Set(["delete-note", "delete-tag"]);

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
  if (tool.name === ATTACHMENT_UPLOAD_MINT_TOOL) return false;
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
 */
export function serverInstruction(vaultName: string, description: string | null): string {
  const base =
    `Parachute vault "${vaultName}" — an agent-native knowledge graph of notes, tags, and links. ` +
    `Read with query-notes; write with create-note / update-note; manage schema with list-tags / update-tag; ` +
    `traverse with find-path; orient with vault-info.`;
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
  const head = d ? `${d}\n\n${base}` : base;
  return `${head}\n\n${attachmentsInstructionBlock({ ticketsEnabled: true })}`;
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
      // KNOWN GAP (cloud#134 A.2, drift vs. the REST door — NOT closed, this
      // gate is ADVISORY): `PATCH /api/vault` (rest/vault.ts) still writes this
      // SAME `description` field at the generic write tier — no admin carve-out
      // exists in vault-do.ts's REST dispatcher for `/vault`, and it stays that
      // way on purpose: the bun vault's own `routes.ts handleVault` REST PATCH
      // has the identical write-tier gap, and re-tiering cloud's REST door
      // alone would fork the wire contract cloud is required to keep
      // byte-shaped with bun (see rest/vault.ts's matching annotation). So this
      // MCP-only admin check narrows just the MCP door's tool surface; a
      // write-tier token can still reach the exact same mutation via REST.
      // Both doors need to move together before this stops being advisory.
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
    };
    if (projection.getting_started) result.getting_started = projection.getting_started;
    if (projection.stats) result.stats = projection.stats;
    return result;
  };
}

/**
 * Map a core domain error to its JSON-RPC error shape (mirrors mcp-http.ts).
 *
 * The trailing generic branch is bun's "backstop" (its own doc comment:
 * "nothing falls through to the unstructured isError text except a TRULY
 * unknown error") — ported here because the attachment-ticket mint tools'
 * validation errors (`missing_required_field`, `invalid_query`,
 * `file_too_large`, `blocked_upload_extension`, …) are plain
 * `structuredError()` leaves (core/src/mcp.ts), not one of the four
 * dedicated domain-error classes above. Before this branch existed, EVERY
 * `structuredError()` throw on cloud MCP silently degraded to unstructured
 * `isError: true` text — losing `error_type` entirely, a real drift from
 * bun's byte-shape (caught by this PR's own conformance suite on the mint
 * tools' `missing_required_field` case). Not ticket-specific: this closes
 * the gap for every core tool's `structuredError()` leaf on this door.
 */
function mapDomainError(err: unknown): { code: number; data: Record<string, unknown> } | null {
  const e = err as {
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
    hint?: string;
    limit?: unknown;
    got?: unknown;
    extension?: string;
    how_to?: string;
  };
  switch (e?.code) {
    case "CONFLICT":
      return {
        code: INVALID_REQUEST,
        data: {
          error_type: "conflict",
          current_updated_at: e.current_updated_at ?? null,
          your_updated_at: e.expected_updated_at,
          path: e.note_path ?? null,
          note_id: e.note_id,
        },
      };
    case "TRANSITION_CONFLICT":
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
        },
      };
    case "SCHEMA_VALIDATION":
      return { code: INVALID_PARAMS, data: { error_type: "schema_validation", violations: e.violations ?? [] } };
    case "PRECONDITION_REQUIRED":
      return {
        code: INVALID_PARAMS,
        data: { error_type: "precondition_required", note_id: e.note_id, path: e.note_path ?? null },
      };
    default:
      if (typeof e?.error_type === "string") {
        return {
          code: INVALID_PARAMS,
          data: {
            error_type: e.error_type,
            ...(e.field !== undefined ? { field: e.field } : {}),
            ...(e.hint !== undefined ? { hint: e.hint } : {}),
            ...(e.limit !== undefined ? { limit: e.limit } : {}),
            ...(e.got !== undefined ? { got: e.got } : {}),
            ...(e.extension !== undefined ? { extension: e.extension } : {}),
            ...(e.how_to !== undefined ? { how_to: e.how_to } : {}),
          },
        };
      }
      return null;
  }
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
): McpToolDef[] {
  const writeContext = { actor: auth.actor, via: auth.via === "operator" ? "operator" : "mcp" };
  const tools = generateMcpTools(store, {
    writeContext,
    attachmentTickets: { provider: attachmentTickets.provider, vaultName, urlBase: attachmentTickets.urlBase },
  });
  return tools.filter((t) => hasScopeForVault(auth.scopes, vaultName, requiredVerbForTool(t)));
}

async function handleToolCall(
  id: JsonRpcId,
  params: Record<string, unknown> | undefined,
  tools: McpToolDef[],
  writeGate: McpWriteGate,
  attachmentMintGate: (declaredBytes: number) => Response | null,
): Promise<JsonRpcMessage> {
  const name = typeof params?.name === "string" ? params.name : "";
  const args = (params?.arguments ?? {}) as Record<string, unknown>;
  const tool = tools.find((t) => t.name === name);
  // Unknown / not-visible tool → in-band tool error (not a JSON-RPC error), so
  // callers can't distinguish "hidden admin tool" from "no such tool".
  if (!tool) {
    return result(id, { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true });
  }
  if (name === ATTACHMENT_UPLOAD_MINT_TOOL) {
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
      if (blocked) return gateError(id, blocked);
    }
  } else if (isGatedWrite(tool, args)) {
    // The paywall + cap gate — a forward-mutating verb (create/update/prune) gets
    // the SAME frozen-then-cap enforcement the REST write path applies; read-class
    // AND delete-class verbs pass through (REST exempts both). MCP is the flagship
    // write door, so without this an expired (frozen) tenant's connected AI could
    // keep writing forever and a two-meter notes-cap-full vault could keep growing.
    const blocked = writeGate();
    if (blocked) return gateError(id, blocked);
  }
  try {
    const out = await tool.execute(args);
    return result(id, { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] });
  } catch (err) {
    const domain = mapDomainError(err);
    const message = err instanceof Error ? err.message : "Unknown error";
    if (domain) return rpcError(id, domain.code, message, domain.data);
    return result(id, { content: [{ type: "text", text: `Error: ${message}` }], isError: true });
  }
}

async function handleOne(
  m: JsonRpcMessage,
  ctx: {
    tools: McpToolDef[];
    vaultName: string;
    description: string | null;
    writeGate: McpWriteGate;
    attachmentMintGate: (declaredBytes: number) => Response | null;
  },
): Promise<JsonRpcMessage> {
  const { id = null, method, params } = m;
  try {
    switch (method) {
      case "initialize": {
        const requested = typeof params?.protocolVersion === "string" ? params.protocolVersion : "";
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : LATEST_PROTOCOL_VERSION;
        return result(id, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: `parachute-vault/${ctx.vaultName}`, version: "0.1.0" },
          instructions: serverInstruction(ctx.vaultName, ctx.description),
        });
      }
      case "tools/list":
        return result(id, {
          tools: ctx.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        });
      case "tools/call":
        return handleToolCall(id, params, ctx.tools, ctx.writeGate, ctx.attachmentMintGate);
      case "ping":
        return result(id, {});
      default:
        return rpcError(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  } catch (err) {
    return rpcError(id, INTERNAL_ERROR, err instanceof Error ? err.message : "Internal error");
  }
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
  tickets: { provider: AttachmentTicketProvider; mintGate: (declaredBytes: number) => Response | null },
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
  const isInit = messages.some((m) => m.method === "initialize");
  if (!isInit) {
    const pv = req.headers.get("mcp-protocol-version");
    if (pv !== null && !SUPPORTED_PROTOCOL_VERSIONS.includes(pv)) {
      return jsonRpcHttpError(
        400,
        -32000,
        `Bad Request: Unsupported protocol version: ${pv} (supported versions: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")})`,
      );
    }
  }

  const requests = messages.filter(isRequest);
  if (requests.length === 0) {
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
  const tools = visibleTools(store, vaultName, auth, { provider: tickets.provider, urlBase: ticketUrlBase });
  // Wire the server-layer vault-info override onto the caller-visible tool set
  // (core ships a placeholder execute — "must be configured by the server
  // layer"). Parity with bun's mcp-tools.ts overrideVaultInfo.
  overrideVaultInfo(tools, { vaultName, auth, description, origin, ctx: vaultInfo });
  const ctx = { tools, vaultName, description, writeGate, attachmentMintGate: tickets.mintGate };
  const responses: JsonRpcMessage[] = [];
  for (const m of requests) responses.push(await handleOne(m, ctx));

  const body = responses.length === 1 ? responses[0] : responses;
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
