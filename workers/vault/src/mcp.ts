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
import { generateMcpTools, type McpToolDef } from "@openparachute/core/src/mcp.js";
import type { Store } from "@openparachute/core/src/types.js";
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

/** A forward-mutating tool (create/update/prune) — the class the REST
 *  POST/PATCH/PUT cap+frozen gate covers. Read tools and DELETE-class tools are
 *  exempt (REST exempts both), so this is the exact "should the write gate run"
 *  predicate. */
function isGatedWrite(tool: McpToolDef): boolean {
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
 */
export function serverInstruction(vaultName: string, description: string | null): string {
  const base =
    `Parachute vault "${vaultName}" — an agent-native knowledge graph of notes, tags, and links. ` +
    `Read with query-notes; write with create-note / update-note; manage schema with list-tags / update-tag; ` +
    `traverse with find-path; orient with vault-info.`;
  const d = description?.trim();
  return d ? `${d}\n\n${base}` : base;
}

/** Map a core domain error to its JSON-RPC error shape (mirrors mcp-http.ts). */
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
 */
function visibleTools(store: Store, vaultName: string, auth: AuthResult): McpToolDef[] {
  const writeContext = { actor: auth.actor, via: auth.via === "operator" ? "operator" : "mcp" };
  const tools = generateMcpTools(store, { writeContext });
  return tools.filter((t) => hasScopeForVault(auth.scopes, vaultName, requiredVerbForTool(t)));
}

async function handleToolCall(
  id: JsonRpcId,
  params: Record<string, unknown> | undefined,
  tools: McpToolDef[],
  writeGate: McpWriteGate,
): Promise<JsonRpcMessage> {
  const name = typeof params?.name === "string" ? params.name : "";
  const args = (params?.arguments ?? {}) as Record<string, unknown>;
  const tool = tools.find((t) => t.name === name);
  // Unknown / not-visible tool → in-band tool error (not a JSON-RPC error), so
  // callers can't distinguish "hidden admin tool" from "no such tool".
  if (!tool) {
    return result(id, { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true });
  }
  // The paywall + cap gate — a forward-mutating verb (create/update/prune) gets
  // the SAME frozen-then-cap enforcement the REST write path applies; read-class
  // AND delete-class verbs pass through (REST exempts both). MCP is the flagship
  // write door, so without this an expired (frozen) tenant's connected AI could
  // keep writing forever and a two-meter notes-cap-full vault could keep growing.
  if (isGatedWrite(tool)) {
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
  ctx: { tools: McpToolDef[]; vaultName: string; description: string | null; writeGate: McpWriteGate },
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
        return handleToolCall(id, params, ctx.tools, ctx.writeGate);
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

  const tools = visibleTools(store, vaultName, auth);
  const ctx = { tools, vaultName, description, writeGate };
  const responses: JsonRpcMessage[] = [];
  for (const m of requests) responses.push(await handleOne(m, ctx));

  const body = responses.length === 1 ? responses[0] : responses;
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
