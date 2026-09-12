/**
 * B4 doctor — vault 41d91be routes.ts:4287-4294, routing.ts:1051-1071.
 * Twins: routing.test.ts:2569-2601,2630-2636; contract-taxonomy.test.ts:243-296;
 * doctor-scope.test.ts:47-61; tag-integrity-mcp.test.ts:168-196,227-263;
 * mcp-manifest.test.ts:69. P5 compares doors directly (cloud-only); P8 confirms
 * the existing auth gate. P9's 405 is sourced from routing.ts:1052-1054,
 * which has no bun doctor method test at the pin.
 */
import { SELF, env, runInDurableObject } from "cloudflare:test";
import { declareField } from "@openparachute/core/src/indexed-fields.js";
import { describe, expect, it } from "vitest";
import { base, freshVault, mintToken, op, createNote } from "./helpers.ts";

async function rpc(v: string, token: string, method: string, params?: unknown) {
  const res = await SELF.fetch(`${base(v)}/mcp`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  expect(res.status).toBe(200);
  return await res.json() as any;
}

async function brokenFixture() {
  const v = freshVault("doctor");
  const admin = await mintToken({ vault: v, scopes: `vault:${v}:admin` });
  const put = async (name: string, body: unknown) => {
    const r = await SELF.fetch(`${base(v)}/api/tags/${name}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${admin}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(r.status).toBe(200);
    return r.json();
  };
  await put("orphan-child", { parent_names: ["ghost-parent"] });
  await put("cyc-a", {}); await put("cyc-b", { parent_names: ["cyc-a"] });
  await put("metric", { fields: { n: { type: "integer", indexed: true } } });
  await put("launch-v2", {});
  await createNote(v, { content: "current epic", tags: ["launch-v2"], metadata: { epic: "launch-v2" } });
  await createNote(v, { content: "stale epic reference", tags: ["launch-v2"], metadata: { epic: "launch-v1" } });
  // Guard-bypassing historical states, as contract-taxonomy.test.ts:250-263.
  await runInDurableObject(env.VAULT.get(env.VAULT.idFromName(v)), async (inst: any) => {
    const db = inst.store.db;
    db.prepare("UPDATE tags SET parent_names = ? WHERE name = ?").run(JSON.stringify(["cyc-b"]), "cyc-a");
    await inst.store.createNote("bad metric", { tags: ["metric"], metadata: { n: "not-a-number" } });
    declareField(db, "legacy_status", "TEXT", "ghost-declarer");
  });
  return { v, admin };
}
async function report(v: string) {
  const res = await op(v, "/api/doctor"); expect(res.status).toBe(200);
  return await res.json() as any;
}

describe("B4 doctor parity", () => {
  it("P1 operator GET reports the integrity scan", async () => {
    const v = freshVault("doctor"); const res = await op(v, "/api/doctor"); const body = await res.json() as any;
    expect(res.status).toBe(200); expect(Array.isArray(body.findings)).toBe(true);
    expect(typeof body.summary).toBe("string"); expect(typeof body.scanned_at).toBe("string");
    expect(Number.isNaN(Date.parse(body.scanned_at))).toBe(false);
  });
  it("P9 operator POST returns the method error", async () => {
    const res = await op(freshVault("doctor"), "/api/doctor", { method: "POST" }); const body = await res.json() as any;
    expect(res.status).toBe(405); expect(body.error_type).toBe("method_not_allowed");
  });
  it("P10 MCP already exposes doctor to read tokens", async () => {
    const v = freshVault("doctor"); const token = await mintToken({ vault: v, scopes: `vault:${v}:read` });
    const list = await rpc(v, token, "tools/list"); expect(list.result.tools.map((t: any) => t.name)).toContain("doctor");
    const body = await rpc(v, token, "tools/call", { name: "doctor", arguments: {} });
    expect(body.result.isError).toBeFalsy(); expect(JSON.parse(body.result.content[0].text).findings).toBeDefined();
  });
  it("P2 a fresh seeded vault is doctor-clean", async () => {
    const body = await report(freshVault("doctor"));
    expect(body.findings).toEqual([]); expect(body.summary).toContain("clean");
  });
  it("P3 reports all five finding types in core order", async () => {
    const { v } = await brokenFixture(); const body = await report(v);
    expect([...new Set(body.findings.map((f: any) => f.type))]).toEqual([
      "dangling_parent_name", "parent_names_cycle", "mixed_type_indexed_field",
      "orphaned_indexed_field_declarer", "dead_tag_metadata_reference",
    ]);
  });
  it("P4 finding shapes match the core twin", async () => {
    const { v } = await brokenFixture(); const { findings } = await report(v);
    const byType = new Map<string, any>(findings.map((f: any) => [f.type, f]));
    expect(byType.get("dangling_parent_name")).toMatchObject({ subject: "orphan-child", severity: "warning" });
    expect(byType.get("parent_names_cycle").severity).toBe("error");
    expect(byType.get("mixed_type_indexed_field")).toMatchObject({ subject: "n", severity: "error" });
    expect(byType.get("orphaned_indexed_field_declarer").subject).toBe("legacy_status");
    const dead = byType.get("dead_tag_metadata_reference");
    expect(dead).toMatchObject({ subject: "metadata.epic", heuristic: true });
    expect(dead.detail).toContain("launch-v1");
    for (const f of findings) if (f.type !== "dead_tag_metadata_reference") expect("heuristic" in f).toBe(false);
  });
  it("P5 REST and MCP agree on one fixture, excluding scanned_at", async () => {
    const { v, admin } = await brokenFixture(); const rest = await report(v);
    const body = await rpc(v, admin, "tools/call", { name: "doctor", arguments: {} });
    const mcp = JSON.parse(body.result.content[0].text);
    expect(rest.findings).toEqual(mcp.findings); expect(rest.summary).toEqual(mcp.summary);
  });
  it.each([["P6", "read"], ["P7", "write"]])("%s %s tokens can read doctor", async (_pin, verb) => {
    const v = freshVault("doctor"); const token = await mintToken({ vault: v, scopes: `vault:${v}:${verb}` });
    const res = await SELF.fetch(`${base(v)}/api/doctor`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200); expect((await res.json() as any).findings).toBeDefined();
  });
  it("P8 unauthenticated requests remain rejected", async () => {
    expect((await SELF.fetch(`${base(freshVault("doctor"))}/api/doctor`)).status).toBe(401);
  });
});
