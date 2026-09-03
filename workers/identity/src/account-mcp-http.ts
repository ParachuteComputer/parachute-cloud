/**
 * The account-level MCP endpoint (Wave A PR3) — `my.parachute.computer/account/mcp`.
 *
 * A stateless Streamable-HTTP MCP server, POST-only JSON-response mode, run
 * IN-PROCESS in the identity worker (everything the tools need — the account-token
 * validator, D1 ownership, the plan cap, the `vault-call.ts` mint bridge — is
 * already wired here; zero new service bindings, one trust domain). The vault
 * worker's root/per-vault `/mcp` is untouched: an account token derives no vault
 * and 401s there.
 *
 * ## Transport framing is TRANSCRIBED from `workers/vault/src/mcp.ts`
 * The Accept-both 406 / Content-Type 415 / parse-error 400 / notifications-202 /
 * GET-405 / DELETE-200 / protocol-version rules are byte-shape-copied from the
 * vault door's `handleMcp` (itself transcribed from the SDK's
 * `WebStandardStreamableHTTPServerTransport`). This is a DELIBERATE DUPLICATION:
 * the vault door's framing lives inside a Durable Object with vault-specific auth
 * + tool wiring, so it can't be imported here without dragging that in — the two
 * copies are pinned to the SAME wire contract by their respective conformance
 * suites (`workers/vault/test/mcp.test.ts` and `test/account-mcp.test.ts`). Keep
 * them in lockstep; a divergence presents as an opaque connector failure.
 *
 * ## The auth gate runs BEFORE any JSON-RPC (the enforcement seam)
 * Bearer → `validateAccountToken` (kid + `iss` pin + jti revocation + strict
 * `aud="account"` + `sub===id` belt) → `buildAccountConnectionGrant` non-null (a
 * read/admin-only account token — the 10-min cookie bearer — does NOT pass; only
 * a legacy account-vaults OR composed connection grant opens this door) →
 * suspended-owner refusal.
 * A failure is a 401/403 carrying the RFC 9728 `WWW-Authenticate` challenge that
 * points at THIS resource's PRM, so a bare 401 walks a spec-following client to
 * discovery.
 */
import { ACCOUNT_VAULTS_UNNARROWED } from "@openparachute/door-contract";
import { validateAccountToken } from "./account-auth.ts";
import {
  ACCOUNT_MCP_TOOLS,
  type AccountConnectionGrant,
  type AccountToolContext,
  AccountToolError,
  buildAccountConnectionGrant,
} from "./account-mcp.ts";
import { type OAuthDeps, frontDoorOrigin, jsonResponse } from "./oauth-shared.ts";
import { type User, getUserById } from "./users.ts";

// --- transport constants (transcribed from workers/vault/src/mcp.ts) ---------

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

// --- CORS (wildcard; expose the WWW-Authenticate challenge) -------------------

/** Wildcard CORS on every account-MCP response so a browser MCP client can read
 *  both the body AND the 401 challenge. The endpoint is Bearer-gated (never
 *  cookie-derived), so the wildcard is correct — nothing here is ambient-auth. */
function withMcpCors(res: Response): Response {
  res.headers.set("access-control-allow-origin", "*");
  res.headers.set("access-control-expose-headers", "WWW-Authenticate");
  return res;
}

/** OPTIONS preflight — the MCP POST is not a CORS-simple request (custom
 *  Authorization/Accept/Content-Type headers), so a browser client preflights. */
function preflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, DELETE, OPTIONS",
      "access-control-allow-headers": "Authorization, Content-Type, Accept, Mcp-Protocol-Version",
      "access-control-max-age": "86400",
    },
  });
}

/** The SDK's `createJsonErrorResponse` shape (`{jsonrpc,error:{code,message},id:null}`). */
function jsonRpcHttpError(status: number, code: number, message: string): Response {
  return withMcpCors(
    new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

// --- discovery: the RFC 9728 PRM + challenge for this resource ---------------

/**
 * The advertised canonical resource — the FRONT DOOR origin (`my.` in prod, the
 * self-referential origin in staging), NOT `deps.issuer` (which stays `cloud.`
 * through Phase 4). The account-MCP endpoint lands on `my./account/mcp`, so its
 * PRM `resource` + the challenge point there; the authorization SERVER is still
 * the issuer.
 */
function accountMcpResource(deps: OAuthDeps): string {
  return `${frontDoorOrigin(deps)}/account/mcp`;
}

/** The RFC 9728 `WWW-Authenticate` challenge value for an account-MCP 401/403.
 *  Points at THIS resource's PRM so a bare 401 walks the client to discovery. */
function accountMcpChallenge(deps: OAuthDeps): string {
  return `Bearer resource_metadata="${frontDoorOrigin(deps)}/.well-known/oauth-protected-resource/account/mcp"`;
}

/**
 * `GET /.well-known/oauth-protected-resource/account/mcp` — the RFC 9728 PRM for
 * the account-MCP resource. Public + wildcard-CORS. The PRM (not the AS metadata
 * doc — ADVERTISED_SCOPES stays unchanged) is the discovery carrier for the
 * account-vaults connection scope: a spec-following client reads
 * `scopes_supported: ["account:vaults"]` (the un-narrowed request form) and asks
 * for it; the issuer's consent step binds the id + narrows to the chosen vaults.
 */
export function accountMcpProtectedResource(deps: OAuthDeps): Response {
  return jsonResponse(
    {
      resource: accountMcpResource(deps),
      authorization_servers: [deps.issuer],
      scopes_supported: [ACCOUNT_VAULTS_UNNARROWED],
      bearer_methods_supported: ["header"],
      resource_documentation: "https://parachute.computer",
    },
    200,
    { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS" },
  );
}

// --- the auth gate -----------------------------------------------------------

/** Pull the `Bearer <token>` value from the Authorization header, or null. */
function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1]!.trim() : null;
}

type AuthResult =
  | { ok: true; accountId: string; grant: AccountConnectionGrant; user: User }
  | { ok: false; status: 401 | 403; error: string; message: string };

/**
 * The account-MCP auth gate. In ORDER:
 *   1. Bearer present → else 401.
 *   2. `validateAccountToken` — kid + `iss` pin + jti revocation + strict
 *      `aud="account"` + `sub===id` belt (account-auth.ts). Failure → its
 *      401/403.
 *   3. `buildAccountConnectionGrant(scopes, sub)` non-null — a legacy OR composed
 *      connection grant is REQUIRED. A read/admin-only account token (the
 *      cookie-minted 10-min bearer) carries no such grant → 403; not an MCP
 *      credential.
 *   4. Suspended-owner refusal (the read-time chokepoint C1's stateless
 *      validator defers to the caller) → 401.
 */
async function authenticate(db: D1Database, req: Request, deps: OAuthDeps): Promise<AuthResult> {
  const token = bearerToken(req);
  if (!token) return { ok: false, status: 401, error: "invalid_token", message: "missing bearer token" };

  const validated = await validateAccountToken(db, token, { issuer: deps.issuer });
  if (!validated.ok) {
    return { ok: false, status: validated.status, error: validated.error, message: validated.message };
  }
  const accountId = validated.token.accountId;

  // Accept a LEGACY account-vaults grant OR a COMPOSED grant (unified /mcp):
  // buildAccountConnectionGrant unifies both and returns null only when the token
  // confers nothing that opens this door (no all-vaults grant, no per-vault grant,
  // no create capability). A read/admin-only account token (the cookie-minted
  // 10-min bearer) carries no such grant → 403; it is not an MCP credential.
  const grant = buildAccountConnectionGrant(validated.token.scopes, accountId);
  if (grant === null) {
    return {
      ok: false,
      status: 403,
      error: "insufficient_scope",
      message: "the account MCP requires an account-vaults connection scope (account:<id>:vaults)",
    };
  }

  const user = await getUserById(db, accountId);
  // A DELETED account (migration 0023) gets the exact same "account not
  // found" response as a missing row — no oracle, mirroring requireAccount
  // (account-api.ts) — never the distinguishable `account_suspended` below.
  if (!user || user.deletedAt !== null) {
    return { ok: false, status: 401, error: "invalid_token", message: "account not found" };
  }
  if (user.suspendedAt !== null) {
    return { ok: false, status: 401, error: "account_suspended", message: "this account is suspended" };
  }

  return { ok: true, accountId, grant, user };
}

/** An auth-failure Response: `{error, error_description}` JSON + the RFC 9728
 *  challenge, wrapped in wildcard CORS (so the browser client can read it). */
function authFailure(status: 401 | 403, error: string, message: string, deps: OAuthDeps): Response {
  return withMcpCors(
    jsonResponse({ error, error_description: message }, status, {
      "cache-control": "no-store",
      "WWW-Authenticate": accountMcpChallenge(deps),
    }),
  );
}

// --- JSON-RPC dispatch -------------------------------------------------------

async function handleToolCall(
  id: JsonRpcId,
  params: Record<string, unknown> | undefined,
  ctx: AccountToolContext,
): Promise<JsonRpcMessage> {
  const name = typeof params?.name === "string" ? params.name : "";
  const args = (params?.arguments ?? {}) as Record<string, unknown>;
  const tool = ACCOUNT_MCP_TOOLS.find((t) => t.name === name);
  // Unknown tool → in-band tool error (not a JSON-RPC error), mirroring the
  // vault door — callers can't distinguish "hidden tool" from "no such tool".
  if (!tool) {
    return result(id, { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true });
  }
  try {
    const out = await tool.execute(args, ctx);
    return result(id, { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] });
  } catch (err) {
    // A structured business failure → JSON-RPC error carrying `error_type` (the
    // vault door's mapDomainError shape); anything else → in-band isError text.
    if (err instanceof AccountToolError) {
      return rpcError(id, INVALID_PARAMS, err.message, { error_type: err.errorType, ...err.extra });
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return result(id, { content: [{ type: "text", text: `Error: ${message}` }], isError: true });
  }
}

function instructions(): string {
  return (
    "The Parachute account MCP — one connection across your vaults. " +
    "Use list-vaults to see the vaults this connection can reach, create-vault to add one, " +
    "and query-notes to search across them (omit `vault` to fan out, pass it to target one). " +
    "Reads and writes are scoped to the vaults you granted and currently own."
  );
}

async function handleOne(m: JsonRpcMessage, ctx: AccountToolContext): Promise<JsonRpcMessage> {
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
          serverInfo: { name: "parachute-account", version: "0.1.0" },
          instructions: instructions(),
        });
      }
      case "tools/list":
        return result(id, {
          tools: ACCOUNT_MCP_TOOLS.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        });
      case "tools/call":
        // `await` (not a bare return) so a rejected tool-call promise unwinds
        // INTO this try/catch and becomes a JSON-RPC INTERNAL_ERROR — a bare
        // return would settle the promise outside the guard.
        return await handleToolCall(id, params, ctx);
      case "ping":
        return result(id, {});
      default:
        return rpcError(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  } catch (err) {
    return rpcError(id, INTERNAL_ERROR, err instanceof Error ? err.message : "Internal error");
  }
}

// --- the endpoint ------------------------------------------------------------

/**
 * Handle a request at `/account/mcp`. Registered `app.all` (index.ts) so EVERY
 * method is worker-owned — the `/mcp`-style defensive backstop that keeps the
 * path from ever falling through to the SPA shell (it already sits under the
 * `/account/*` run_worker_first rule; this handler is what answers, not a 404).
 */
export async function handleAccountMcp(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  if (req.method === "OPTIONS") return preflight();

  // Auth gate — BEFORE any JSON-RPC (or method framing): a bare/invalid/wrong
  // credential gets the RFC 9728 challenge, not a transport-shaped answer.
  const auth = await authenticate(db, req, deps);
  if (!auth.ok) return authFailure(auth.status, auth.error, auth.message, deps);

  if (req.method === "DELETE") return withMcpCors(new Response(null, { status: 200 }));
  if (req.method !== "POST") {
    // GET (server-push SSE) + everything else. No server-initiated stream in v1.
    return withMcpCors(
      new Response(
        JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }),
        { status: 405, headers: { Allow: "POST, DELETE, OPTIONS", "Content-Type": "application/json" } },
      ),
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

  // A JSON-RPC batch (top-level array) is accepted with NO explicit size cap in
  // v1 — EXACT parity with the vault door's `handleMcp`, whose transport framing
  // this file transcribes. A batch-size ceiling is a legitimate shared-transport
  // hardening, but it belongs on BOTH doors at once (a per-door cap would diverge
  // the wire contract the two conformance suites pin); defer it to the shared
  // Streamable-HTTP transport work rather than forking it here. Each request in
  // the batch is still auth-gated (the gate ran above) and answered serially.
  const rawMessages = Array.isArray(raw) ? raw : [raw];
  const messages: JsonRpcMessage[] = [];
  for (const m of rawMessages) {
    if (!isJsonRpc(m)) return jsonRpcHttpError(400, PARSE_ERROR, "Parse error: Invalid JSON-RPC message");
    messages.push(m);
  }

  // Mcp-Protocol-Version validation (SDK rule): a NON-initialize POST carrying an
  // unsupported version header → 400. Absent header is fine; initialize negotiates
  // in-body and is exempt.
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
    return withMcpCors(new Response(null, { status: 202 }));
  }

  const ctx: AccountToolContext = {
    db,
    deps,
    accountId: auth.accountId,
    grant: auth.grant,
    user: auth.user,
    // Cloud account-MCP is Bearer-only. A NIP-98 door would set authKind
    // "nostr" and the verified event pubkey here; until then hop tokens
    // carry no permissions.principal_pubkey (cloud#278).
    principal: { authKind: "bearer" },
  };
  const responses: JsonRpcMessage[] = [];
  for (const m of requests) responses.push(await handleOne(m, ctx));

  const body = responses.length === 1 ? responses[0] : responses;
  return withMcpCors(
    new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }),
  );
}
