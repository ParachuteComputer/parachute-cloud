/**
 * The canary probe (L6-03): what "a vault answers its client" means, in two
 * requests a real client makes. One REST note read (wakes the vault's Durable
 * Object and reads its SQLite) and one MCP `tools/list` (the MCP door, the
 * same DO). Either failing is a failed canary; the reason says which step and
 * how it failed.
 *
 * PURE and import-free ON PURPOSE: the identity health cron runs it through
 * the mint seam (ops-canary.ts), and workers/vault/test/canary.test.ts runs
 * the same function against a REAL vault DO (healthy, and one that failed to
 * boot), so the request shapes are proven where they land.
 * scripts/uptime-check.sh is the bash twin for external schedulers.
 */

/** Sends one request to the canary vault's base URL + `apiPath`, authorized as the canary client. */
export type CanarySend = (
  method: "GET" | "POST",
  apiPath: string,
  init: { headers: Record<string, string>; json?: unknown; signal: AbortSignal },
) => Promise<Response>;

/** Budget per request; a hung DO is a failed canary, not a stuck cron. */
export const CANARY_REQUEST_TIMEOUT_MS = 10_000;

/** MCP Streamable HTTP: a POST must accept both (the vault 406s otherwise). */
const MCP_ACCEPT = "application/json, text/event-stream";

/** One line, no control characters, bounded: an alert reason, never a body dump. */
function oneLine(s: string, max = 200): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** "HTTP 500 Internal server error (NewerSchemaError: …)" from a vault error response. */
async function httpReason(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  let said = "";
  try {
    const b = JSON.parse(text) as { error?: unknown; detail?: unknown };
    const error = typeof b.error === "string" ? b.error : typeof b.error === "object" && b.error ? JSON.stringify(b.error) : "";
    said = [error, typeof b.detail === "string" ? `(${b.detail})` : ""].filter(Boolean).join(" ");
  } catch {
    said = text;
  }
  return oneLine(`HTTP ${res.status}${said ? ` ${said}` : ""}`);
}

function errText(err: unknown): string {
  return oneLine(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
}

type JsonRpcReply = { result?: { tools?: unknown }; error?: { code?: unknown; message?: unknown } };

/** The JSON-RPC message of a JSON or SSE (`data: {...}`) MCP response. */
function mcpMessage(contentType: string, text: string): unknown {
  if (contentType.includes("text/event-stream")) {
    const data = text.split("\n").find((l) => l.startsWith("data:"));
    return data ? JSON.parse(data.slice(5)) : null;
  }
  return JSON.parse(text);
}

/**
 * Probe the canary vault. `null` = healthy; otherwise one line naming the step
 * that failed ("note read: …" / "mcp tools/list: …"). Never throws.
 */
export async function probeCanaryVault(
  send: CanarySend,
  notePath: string,
  timeoutMs = CANARY_REQUEST_TIMEOUT_MS,
): Promise<string | null> {
  try {
    const res = await send("GET", `/api/notes/${encodeURIComponent(notePath)}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status !== 200) return `note read: ${await httpReason(res)}`;
    const note = (await res.json().catch(() => null)) as { id?: unknown } | null;
    if (typeof note?.id !== "string") return "note read: HTTP 200 but no note in the body";
  } catch (err) {
    return `note read: ${errText(err)}`;
  }

  try {
    const res = await send("POST", "/mcp", {
      headers: { accept: MCP_ACCEPT },
      json: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status !== 200) return `mcp tools/list: ${await httpReason(res)}`;
    const text = await res.text();
    let msg: JsonRpcReply | null;
    try {
      msg = mcpMessage(res.headers.get("content-type") ?? "", text) as JsonRpcReply | null;
    } catch {
      return `mcp tools/list: HTTP 200 but not JSON-RPC: ${oneLine(text, 120)}`;
    }
    if (msg?.error) return oneLine(`mcp tools/list: JSON-RPC error ${String(msg.error.code)} ${String(msg.error.message)}`);
    const tools = msg?.result?.tools;
    if (!Array.isArray(tools) || tools.length === 0) return "mcp tools/list: HTTP 200 but no tools listed";
    return null;
  } catch (err) {
    return `mcp tools/list: ${errText(err)}`;
  }
}
