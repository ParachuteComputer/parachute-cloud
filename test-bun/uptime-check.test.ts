/**
 * scripts/uptime-check.sh's canary step (L6-03), run as shipped against a
 * local stand-in for the identity worker's POST /ops/canary-token and a vault
 * (a Bun server on 127.0.0.1, port 0). The vault side answers as a healthy
 * vault does, or as a DO that failed to boot does (every request 500s).
 * Only the network is faked; the script, curl and jq are real.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "uptime-check.sh");
const OPS = "ops-canary-made-up-secret";
const VAULT_TOKEN = "made-up.vault.jwt";

type Mode = "healthy" | "boot-failed" | "mcp-503" | "sse";
let mode: Mode = "healthy";
const seen: Array<{ path: string; auth: string }> = [];

const json = (b: unknown, status = 200) => Response.json(b, { status });
const bootFailed = () =>
  json({ error: "Internal server error", detail: "NewerSchemaError: vault schema 19 is newer than this engine (18)" }, 500);

let origin = "";
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req): Promise<Response> {
    const path = new URL(req.url).pathname;
    seen.push({ path, auth: req.headers.get("authorization") ?? "" });
    if (path === "/health") return json({ status: "ok" });
    if (path === "/ops/canary-token" && req.method === "POST") {
      if (req.headers.get("authorization") !== `Bearer ${OPS}`) return json({ error: "unauthorized" }, 401);
      return json({ vault_token: VAULT_TOKEN, expires_in: 300, vault_url: `${origin}/vault/canary`, note: "canary" });
    }
    if (req.headers.get("authorization") !== `Bearer ${VAULT_TOKEN}`) return json({ error: "unauthorized" }, 401);
    if (path === "/vault/canary/api/notes/canary") {
      return mode === "boot-failed" ? bootFailed() : json({ id: "n1", path: "canary", content: "canary" });
    }
    if (path === "/vault/canary/mcp" && req.method === "POST") {
      if (mode === "boot-failed") return bootFailed();
      if (mode === "mcp-503") return json({ error: "Service unavailable" }, 503);
      const msg = { jsonrpc: "2.0", id: 1, result: { tools: [{ name: "query-notes" }] } };
      if (mode === "sse") {
        return new Response(`event: message\ndata: ${JSON.stringify(msg)}\n\n`, { headers: { "content-type": "text/event-stream" } });
      }
      return json(msg);
    }
    return json({ error: "Not found" }, 404);
  },
});
origin = `http://127.0.0.1:${server.port}`;
afterAll(() => server.stop(true));

async function run(m: Mode, canary: boolean): Promise<{ code: number; out: string }> {
  mode = m;
  seen.length = 0;
  const proc = Bun.spawn(["bash", SCRIPT, `${origin}/health`], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      ATTEMPTS: "1",
      RETRY_DELAY: "0",
      TIMEOUT: "5",
      ...(canary ? { CANARY_TOKEN_URL: `${origin}/ops/canary-token`, CANARY_OPS_TOKEN: OPS } : {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = [await new Response(proc.stdout).text(), await new Response(proc.stderr).text()];
  const code = await proc.exited;
  expect(out + err).not.toContain(OPS);
  expect(out + err).not.toContain(VAULT_TOKEN);
  return { code, out };
}

describe("uptime-check.sh canary step", () => {
  it("unset: skipped with one line, no canary request, exit 0", async () => {
    const r = await run("healthy", false);
    expect(r.code).toBe(0);
    expect(r.out.split("\n").filter((l) => /canary/i.test(l))).toEqual([
      "Canary vault: skipped (CANARY_TOKEN_URL / CANARY_OPS_TOKEN unset).",
    ]);
    expect(seen.map((s) => s.path)).toEqual(["/health"]);
  });

  it("healthy: token, note read and MCP tools/list, exit 0", async () => {
    const r = await run("healthy", true);
    expect(r.code).toBe(0);
    expect(r.out).toContain("| canary vault (note read + MCP tools/list) | ok |");
    expect(seen.map((s) => s.path)).toEqual(["/health", "/ops/canary-token", "/vault/canary/api/notes/canary", "/vault/canary/mcp"]);
  });

  it("healthy over SSE: the JSON-RPC message in the data: line counts", async () => {
    const r = await run("sse", true);
    expect(r.code).toBe(0);
    expect(r.out).toContain("| canary vault (note read + MCP tools/list) | ok |");
  });

  it("a DO that fails to boot: DOWN with the step and the vault's reason, exit 1", async () => {
    const r = await run("boot-failed", true);
    expect(r.code).toBe(1);
    expect(r.out).toContain("uptime check **failed**");
    expect(r.out).toContain(
      "| canary vault (note read + MCP tools/list) | **DOWN** — note read: HTTP 500 Internal server error (NewerSchemaError: vault schema 19 is newer than this engine (18)) (after 1 tries) |",
    );
  });

  it("MCP 5xx with a readable note: DOWN on the MCP step, exit 1", async () => {
    const r = await run("mcp-503", true);
    expect(r.code).toBe(1);
    expect(r.out).toContain("**DOWN** — mcp tools/list: HTTP 503 Service unavailable");
  });
});
