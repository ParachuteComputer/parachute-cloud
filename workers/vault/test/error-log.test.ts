/**
 * Server-side error log lines (T-420, audit L6-02 / L6-03): a crash the
 * caller only sees as `isError` or a bare 500 must leave one line an operator
 * can find in Workers Logs — the error's class, a redacted message, the stack
 * frames, the worker version and the vault's opaque id. Never the arguments,
 * the note content or the vault name. Pinned here:
 *   - an MCP tool that throws a TypeError → exactly one `event=mcp_tool_error`
 *     line, with the tool name and class, and nothing the caller sent;
 *   - a domain refusal, an unknown tool → no such line;
 *   - a vault DO whose engine refuses to boot → one `event=do_boot_error` line
 *     per instance, a `do:boot` count, and the platform can still read it;
 *   - the message redaction and frame trimming (the shared line shape, LOGLINE).
 */
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SCHEMA_VERSION } from "@openparachute/core/src/schema.js";
import { redactMessage, serverErrorLine, stackFrames } from "../src/error-log.ts";
import { createNote, freshVault, mintToken, op } from "./helpers.ts";
import { SELF } from "cloudflare:test";

type Days = Record<string, Record<string, Record<string, number>>>;

/** Every console line written while `fn` runs, as one string per call. */
function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spies = (["error", "warn", "log", "info", "debug"] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    }),
  );
  return { lines, restore: () => spies.forEach((s) => s.mockRestore()) };
}

let capture: ReturnType<typeof captureLogs> | null = null;
afterEach(() => {
  capture?.restore();
  capture = null;
});

function mcp(vault: string, body: unknown): Promise<Response> {
  return op(vault, "/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  });
}

function call(vault: string, name: string, args: Record<string, unknown>): Promise<Response> {
  return mcp(vault, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
}

async function counters(vault: string): Promise<Record<string, number>> {
  const res = await op(vault, `/api/internal/health?since=2000-01-01`);
  expect(res.status, await res.clone().text()).toBe(200);
  const body = (await res.json()) as { days: Days };
  const out: Record<string, number> = {};
  for (const versions of Object.values(body.days)) {
    for (const keys of Object.values(versions)) {
      for (const [k, n] of Object.entries(keys)) out[k] = (out[k] ?? 0) + n;
    }
  }
  return out;
}

const doId = (vault: string) => env.VAULT.idFromName(vault).toString();

describe("MCP tool crash → one server-side log line", () => {
  it("a tool that throws a TypeError logs exactly one mcp_tool_error line with the tool and class, and nothing the caller sent", async () => {
    const v = freshVault("elog");
    const marker = `MARKER-${crypto.randomUUID()}`;
    capture = captureLogs();
    // `tags` as an object: the engine iterates it and throws a real TypeError.
    const res = await call(v, "create-note", { content: `secret ${marker}`, path: `p/${marker}`, tags: { [marker]: 1 } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { isError?: boolean } };
    expect(body.result.isError).toBe(true);

    const lines = capture.lines.filter((l) => l.includes("event=mcp_tool_error"));
    expect(lines, capture.lines.join("\n")).toHaveLength(1);
    const line = lines[0]!;
    expect(line).toContain("tool=create-note");
    expect(line).toContain("class=TypeError");
    expect(line).toMatch(/ msg="[^"]*not iterable[^"]*"/);
    expect(line).toMatch(/ stack="at [^"]+"/);
    expect(line).toMatch(/ version=\S+/);
    expect(line).toContain(`vault_id=${doId(v)}`);
    // Nothing the caller sent, and not the vault's name, anywhere in the logs.
    const all = capture.lines.join("\n");
    expect(all).not.toContain(marker);
    expect(all).not.toContain(v);
    capture.restore();

    // The T-411 counter is unchanged: one server-class count under the tool.
    expect((await counters(v))["mcp:create-note|exception:typeerror"]).toBe(1);
  });

  it("a second crashing tool is named by its own name", async () => {
    const v = freshVault("elog");
    capture = captureLogs();
    await call(v, "query-notes", { tag: 123 });
    const lines = capture.lines.filter((l) => l.includes("event=mcp_tool_error"));
    expect(lines, capture.lines.join("\n")).toHaveLength(1);
    expect(lines[0]).toContain("tool=query-notes");
    expect(lines[0]).toContain("class=TypeError");
  });

  it("a domain refusal and an unknown tool log no mcp_tool_error line", async () => {
    const v = freshVault("elog");
    await createNote(v, { content: "x" });
    capture = captureLogs();
    const missing = await call(v, "update-note", { id: "MARKER-missing", content: "y" });
    expect(((await missing.json()) as { error?: { data?: { error_type?: string } } }).error?.data?.error_type).toBe("not_found");
    await call(v, "no-such-tool", {});
    const ok = await call(v, "query-notes", { search: "x" });
    expect(ok.status).toBe(200);
    expect(capture.lines.filter((l) => l.includes("event=mcp_tool_error"))).toEqual([]);
    expect(capture.lines.join("\n")).not.toContain("MARKER-missing");
  });
});

describe("a vault DO that cannot boot", () => {
  it("logs do_boot_error once per instance, counts do:boot, and the platform can still read the count", async () => {
    const v = freshVault("eboot");
    await createNote(v, { content: "before the rollback" });
    // A newer schema stamp, as after a worker rollback past a schema bump; then
    // reset the object so the next request constructs a fresh instance, whose
    // engine boot refuses the vault (NewerSchemaError).
    // (Two calls: an abort in the same turn would also roll the stamp back.)
    const stub = () => env.VAULT.get(env.VAULT.idFromName(v));
    await runInDurableObject(stub(), async (_inst, state) => {
      state.storage.sql.exec("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)", SCHEMA_VERSION + 1, new Date().toISOString());
    });
    // abort() resets the object; the call that made it rejects by design.
    await runInDurableObject(stub(), async (_inst, state) => state.abort("test: reset the object")).catch(() => {});

    capture = captureLogs();
    for (let i = 0; i < 3; i++) {
      const res = await op(v, "/api/notes");
      expect(res.status).toBe(500);
    }
    const lines = capture.lines.filter((l) => l.includes("event=do_boot_error"));
    expect(lines, capture.lines.join("\n")).toHaveLength(1);
    const line = lines[0]!;
    expect(line).toContain("class=NewerSchemaError");
    expect(line).toMatch(/ msg="[^"]*newer than this vault knows[^"]*"/);
    expect(line).toMatch(/ stack="at [^"]+"/);
    expect(line).toMatch(/ version=\S+/);
    expect(line).toContain(`vault_id=${doId(v)}`);
    expect(capture.lines.join("\n")).not.toContain(v);
    capture.restore();

    // Counted once, server class, and readable by the platform while the
    // vault is still down (the counters live outside the engine's tables).
    const c = await counters(v);
    expect(c["do:boot|exception:newerschemaerror"]).toBe(1);
    // A tenant still gets the 500, not the counters.
    expect((await op(v, "/api/tags")).status).toBe(500);
    // The health read on a broken vault is still platform-only: no token → 401,
    // a tenant's own admin token (not the first-party client) → 403.
    const healthUrl = `https://vault.test/vault/${v}/api/internal/health?since=2000-01-01`;
    expect((await SELF.fetch(healthUrl)).status).toBe(401);
    const tenant = await mintToken({ vault: v, scopes: `vault:${v}:admin`, clientId: "tenant-app" });
    expect((await SELF.fetch(healthUrl, { headers: { Authorization: `Bearer ${tenant}` } })).status).toBe(403);
  });

  it("a vault that boots logs no do_boot_error and counts no do:boot", async () => {
    const v = freshVault("eboot");
    capture = captureLogs();
    await createNote(v, { content: "fine" });
    expect(capture.lines.filter((l) => l.includes("event=do_boot_error"))).toEqual([]);
    capture.restore();
    expect(Object.keys(await counters(v)).some((k) => k.startsWith("do:boot"))).toBe(false);
  });
});

describe("the log line's message and frames", () => {
  it("drops everything from the first quote to the last, collapses newlines, caps at 200 chars", () => {
    expect(redactMessage(`Unexpected token 'M', "MARKER {" is not valid JSON`)).toBe("Unexpected token … is not valid JSON");
    // Quoted input with the same quote inside it (JSON keys): nothing of it survives.
    expect(redactMessage(`Unexpected token 'x', "{"secret": x}" is not valid JSON`)).toBe("Unexpected token … is not valid JSON");
    expect(redactMessage("Note not found: `MARKER`")).toBe("Note not found: …");
    expect(redactMessage("line one\n  line two\r\nthree")).toBe("line one line two three");
    expect(redactMessage("x".repeat(500))).toHaveLength(200);
    // A lone quote drops the rest; an apostrophe counts as a quote (over-redacting is the safe side).
    expect(redactMessage("bad token 'MARKER")).toBe("bad token …");
    expect(redactMessage("Can't update note 'p/MARKER-secret'")).toBe("Can…");
    expect(redactMessage("on string'MARKER'")).toBe("on string…");
    expect(redactMessage("name: ‘MARKER’ “MARKER” «MARKER»")).toBe("name: …");
  });

  it("never takes a frame from the message, even a message line that looks like one", () => {
    const err = new TypeError("bad input\n    at MARKER-user-text");
    expect(stackFrames(err.stack, err.message)).not.toContain("MARKER");
    expect(stackFrames(err.stack, err.message)).toMatch(/^at /);
    // The message changed after the stack was captured: still no message line.
    err.message = "rewritten";
    expect(stackFrames(err.stack, err.message)).not.toContain("MARKER");
  });

  it("a backslash cannot end a quoted value early", () => {
    const line = serverErrorLine("mcp_tool_error", new TypeError("ends in a\\"), { tool: "t", version: "v", vaultId: "id" });
    expect(line).toContain('msg="ends in a\\\\" stack=');
  });

  it("keeps only the 'at …' frames of a stack, at most 10, joined with ' | '", () => {
    const stack = ["TypeError: secret MARKER in the message", "    on a second line", ...Array.from({ length: 12 }, (_, i) => `    at fn${i} (file.js:${i}:1)`)].join("\n");
    const frames = stackFrames(stack);
    expect(frames).not.toContain("MARKER");
    expect(frames.split(" | ")).toHaveLength(10);
    expect(frames.startsWith("at fn0 (file.js:0:1) | at fn1")).toBe(true);
    expect(stackFrames(undefined)).toBe("");
  });
});
