/**
 * Per-vault health counters (T-411, src/health.ts): every request to a vault
 * leaves a count under its route group and status class, every MCP tool call
 * under the tool's own name and its outcome, and the identity worker reads
 * them back through GET /api/internal/health. Pinned here:
 *   - the counts are the real outcomes (2xx / 4xx:<status> / 5xx / tool outcome),
 *   - nothing a caller sent ends up in a key (content, paths, unknown tool names),
 *   - the staging planted failure answers 500 and is counted as such,
 *   - only the platform reads the counters; reading them is not itself counted,
 *   - a destroyed vault keeps nothing,
 *   - a day is capped and old days are pruned.
 */
import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { FIRST_PARTY_CLIENT_ID } from "../src/auth.ts";
import { HEALTH_KEEP_DAYS, HEALTH_MAX_KEYS, HealthSink, OVERFLOW_KEY, OVERFLOW_SERVER_KEY, responseOutcome, routeOf, routerFailureKind, toolErrorOutcome, utcDay } from "../src/health.ts";
import { base, createNote, freshVault, mintToken, op } from "./helpers.ts";

type Days = Record<string, Record<string, Record<string, number>>>;

/** All of a vault's counters, summed over days and versions. */
async function counters(vault: string): Promise<Record<string, number>> {
  const res = await op(vault, `/api/internal/health?since=2000-01-01`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { version: string; days: Days };
  const out: Record<string, number> = {};
  for (const versions of Object.values(body.days)) {
    for (const keys of Object.values(versions)) {
      for (const [k, n] of Object.entries(keys)) out[k] = (out[k] ?? 0) + n;
    }
  }
  return out;
}

function mcp(vault: string, body: unknown): Promise<Response> {
  return op(vault, "/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  });
}

function doStub(vault: string) {
  return env.VAULT.get(env.VAULT.idFromName(vault));
}

describe("health counters — what a vault's requests leave behind", () => {
  it("counts REST outcomes by route group and status class", async () => {
    const v = freshVault("hc");
    await createNote(v, { content: "hello" });
    expect((await op(v, "/api/notes/does-not-exist")).status).toBe(404);
    expect((await op(v, "/api/tags")).status).toBe(200);
    const c = await counters(v);
    expect(c["http:notes|2xx"]).toBe(1);
    expect(c["http:notes|4xx:404"]).toBe(1);
    expect(c["http:tags|2xx"]).toBe(1);
    // The health read itself is not counted, however often it runs.
    await counters(v);
    expect(Object.keys(await counters(v)).some((k) => k.startsWith("http:internal:health"))).toBe(false);
  });

  it("counts MCP tool calls under the tool's own name, and unknown names under one subject", async () => {
    const v = freshVault("hm");
    await mcp(v, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    await mcp(v, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const created = await mcp(v, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "create-note", arguments: { content: "from mcp" } },
    });
    expect(created.status).toBe(200);
    await mcp(v, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "caller-chose-this-name", arguments: {} } });
    const c = await counters(v);
    expect(c["mcp:initialize|ok"]).toBe(1);
    expect(c["mcp:tools/list|ok"]).toBe(1);
    expect(c["mcp:create-note|ok"]).toBe(1);
    expect(c["mcp:unknown-tool|unknown_tool"]).toBe(1);
    expect(c["http:mcp|2xx"]).toBe(4);
    expect(Object.keys(c).join(" ")).not.toContain("caller-chose-this-name");
  });

  it("never stores what the caller sent: no content, path, tag or query in any key", async () => {
    const v = freshVault("hp");
    const marker = "Zq7SecretMarker";
    await createNote(v, { content: `body ${marker}`, path: `Notes/${marker}`, tags: [`t${marker.toLowerCase()}`] });
    await op(v, `/api/notes?search=${marker}`);
    await op(v, `/api/notes/${marker}`);
    await mcp(v, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "query-notes", arguments: { search: marker } },
    });
    const res = await op(v, `/api/internal/health?since=2000-01-01`);
    const raw = await res.text();
    expect(raw.toLowerCase()).not.toContain(marker.toLowerCase());
  });

  it("the staging planted failure answers 500 N times, counted as 5xx, then the vault is normal", async () => {
    const v = freshVault("hf");
    await createNote(v, { content: "before" });
    const arm = await SELF.fetch(`${base(v)}/__test/fail-next?n=2`, { method: "POST" });
    expect(arm.status).toBe(200);
    expect((await op(v, "/api/notes")).status).toBe(500);
    expect((await op(v, "/api/notes")).status).toBe(500);
    expect((await op(v, "/api/notes")).status).toBe(200);
    const c = await counters(v);
    expect(c["http:notes|5xx:500"]).toBe(2);
    expect(c["http:notes|2xx"]).toBe(2);
    // The hook itself is not counted.
    expect(Object.keys(c).some((k) => k.includes("__test") || k.includes("fail"))).toBe(false);
  });

  it("only the platform reads the counters: an owner's own admin token is refused", async () => {
    const v = freshVault("ha");
    await createNote(v, { content: "x" });
    const owner = await mintToken({ vault: v, scopes: `vault:${v}:admin` });
    const refused = await SELF.fetch(`${base(v)}/api/internal/health`, { headers: { authorization: `Bearer ${owner}` } });
    expect(refused.status).toBe(403);
    const platform = await mintToken({
      vault: v,
      scopes: `vault:${v}:admin`,
      vaultScope: [v],
      clientId: FIRST_PARTY_CLIENT_ID,
    });
    const ok = await SELF.fetch(`${base(v)}/api/internal/health`, { headers: { authorization: `Bearer ${platform}` } });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { days: Days };
    expect(Object.keys(body.days)).toContain(utcDay(new Date()));
  });

  it("the nightly usage read (GET /api/internal/config) carries the counters, so collecting costs no extra call", async () => {
    const v = freshVault("hn");
    await createNote(v, { content: "x" });
    const res = await op(v, "/api/internal/config");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { db_bytes: number; health: { version: string; days: Days } };
    expect(typeof body.db_bytes).toBe("number");
    // The test pool binds version metadata with an id and no timestamp.
    const version = body.health.version;
    expect(version === "unversioned" || /~[0-9a-f]{8}$/.test(version)).toBe(true);
    expect(body.health.days[utcDay(new Date())]![version]!["http:notes|2xx"]).toBe(1);
  });

  it("a router-observed failure is counted on a vault that exists, and never creates storage for one that doesn't", async () => {
    const v = freshVault("hx");
    await createNote(v, { content: "x" });
    await (doStub(v) as unknown as { recordRouterFailure(k: string): Promise<void> }).recordRouterFailure("cpu_limit");
    expect((await counters(v))["do|cpu_limit"]).toBe(1);
    const ghost = freshVault("hg");
    await (doStub(ghost) as unknown as { recordRouterFailure(k: string): Promise<void> }).recordRouterFailure("cpu_limit");
    const keys = await runInDurableObject(doStub(ghost), async (_inst, state) => [...(await state.storage.list()).keys()]);
    expect(keys).toEqual([]);
  });

  it("a destroyed vault keeps no counters, and later requests add none", async () => {
    const v = freshVault("hd");
    await createNote(v, { content: "x" });
    const destroyed = await op(v, "/api/internal/destroy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: v }),
    });
    expect(destroyed.status).toBe(200);
    expect((await op(v, "/api/notes")).status).toBe(410);
    const keys = await runInDurableObject(doStub(v), async (_inst, state) => [...(await state.storage.list()).keys()]);
    // Nothing at all is left: the health counters, the name counts (T-456) and every other key.
    expect(keys).toEqual([]);
  });
});

describe("health sink — bounds", () => {
  it("caps a day's distinct keys and puts the rest under one overflow key", async () => {
    const v = freshVault("hk");
    const c = await runInDurableObject(doStub(v), async (_inst, state) => {
      const sink = new HealthSink(state.storage, "v1");
      for (let i = 0; i < HEALTH_MAX_KEYS + 25; i++) await sink.record(`s${i}`, "ok");
      return (await sink.read("2000-01-01"))[utcDay(new Date())]!["v1"]!;
    });
    expect(Object.keys(c).length).toBe(HEALTH_MAX_KEYS + 1);
    expect(c[OVERFLOW_KEY]).toBe(25);
  });

  it("a full day still shows new server errors: they overflow into a server-class key", async () => {
    const v = freshVault("ho");
    const c = await runInDurableObject(doStub(v), async (_inst, state) => {
      const sink = new HealthSink(state.storage, "v1");
      for (let i = 0; i < HEALTH_MAX_KEYS; i++) await sink.record(`s${i}`, "ok");
      await sink.record("http:notes", "5xx:500");
      await sink.record("mcp:create-note", "exception:typeerror");
      await sink.record("http:tags", "4xx:404");
      return (await sink.read("2000-01-01"))[utcDay(new Date())]!["v1"]!;
    });
    expect(c[OVERFLOW_SERVER_KEY]).toBe(2);
    expect(c[OVERFLOW_KEY]).toBe(1);
  });

  it("a tool's thrown error is a client mistake unless it is a runtime, storage or infrastructure fault", () => {
    class QueryError extends Error {}
    class EmbeddingError extends Error {}
    expect(toolErrorOutcome(new Error("bad arg"))).toBe("tool_error");
    expect(toolErrorOutcome(new QueryError("bad query"))).toBe("error:queryerror");
    expect(toolErrorOutcome(new TypeError("x is undefined"))).toBe("exception:typeerror");
    expect(toolErrorOutcome(new EmbeddingError("ai down"))).toBe("exception:embeddingerror");
  });

  it("by-design 503s are named by their type; any other 503 stays a server error", async () => {
    const j = (body: unknown, status = 503) => Response.json(body, { status });
    expect(await responseOutcome(j({ error_type: "import_in_progress" }))).toBe("busy:import_in_progress");
    expect(await responseOutcome(j({ error_type: "vault_busy" }))).toBe("busy:vault_busy");
    expect(await responseOutcome(j({ code: "SUBSCRIPTION_CAP_REACHED" }))).toBe("busy:subscription_cap_reached");
    // With embeddings on, semantic_unavailable means the embed call failed: a server error.
    expect(await responseOutcome(j({ error_type: "semantic_unavailable" }))).toBe("5xx:503");
    expect(await responseOutcome(j({ error: "something else" }))).toBe("5xx:503");
    expect(await responseOutcome(new Response("x", { status: 503 }))).toBe("5xx:503");
    expect(await responseOutcome(j({ ok: true }, 200))).toBe("2xx");
    // The response itself is still readable afterwards (a clone was read).
    const r = j({ error_type: "vault_busy" });
    await responseOutcome(r);
    expect(((await r.json()) as { error_type: string }).error_type).toBe("vault_busy");
  });

  it("prunes days older than the keep window on the first write of a new day", async () => {
    const v = freshVault("hr");
    const days = await runInDurableObject(doStub(v), async (_inst, state) => {
      let now = new Date("2026-01-01T12:00:00Z");
      const sink = new HealthSink(state.storage, "v1", () => now);
      await sink.record("http:notes", "2xx");
      now = new Date("2026-01-02T12:00:00Z");
      await sink.record("http:notes", "2xx");
      now = new Date(Date.parse("2026-01-01T12:00:00Z") + (HEALTH_KEEP_DAYS + 1) * 86_400_000);
      await sink.record("http:notes", "2xx");
      return Object.keys(await sink.read("2000-01-01"));
    });
    expect(days).not.toContain("2026-01-01");
    expect(days).toContain("2026-01-02");
    expect(days.length).toBe(2);
  });

  it("route groups are a fixed set; the router names only platform failures", () => {
    expect(routeOf("/api/notes/abc/versions", false)).toBe("notes");
    expect(routeOf("/api/subscribe", true)).toBe("subscribe-ws");
    expect(routeOf("/api/whatever-a-caller-types", false)).toBe("api:other");
    expect(routeOf("/api/internal/anything", false)).toBe("internal:other");
    expect(routeOf("/api/internal/history-import/finish", false)).toBe("internal:history-import");
    expect(routeOf("/api/internal/history-digest", false)).toBe("internal:history-digest");
    expect(routeOf("/api/internal/health", false)).toBeNull();
    expect(routeOf("/__test/fail-next", false)).toBeNull();
    expect(routerFailureKind(new Error("Durable Object's isolate exceeded its CPU time limit and was reset."))).toBe("cpu_limit");
    expect(routerFailureKind(new Error("Durable Object reset because its code was updated."))).toBe("code_updated");
    expect(routerFailureKind(new TypeError("x is not a function"))).toBeNull();
    expect(routerFailureKind(new Error("Network connection lost."))).toBe("connection_lost");
    expect(routerFailureKind(new Error("internal error; reference = abc123"))).toBe("platform_error");
    expect(routerFailureKind(new Error("my handler hit an internal error somewhere"))).toBeNull();
  });
});
