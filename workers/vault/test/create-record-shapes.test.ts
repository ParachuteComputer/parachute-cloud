/**
 * T-476: production's health report showed create-record throwing TypeError for one vault (`exception:typeerror`, a
 * server fault). The likeliest call is one the tools/list schema allows: a link with no `relationship` to a record
 * that exists. The engine (core mcp.ts checkCreateShapes) now refuses that and every other wrong argument shape before
 * writing; here it is through the real router, Durable Object, MCP door and health counters.
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { base, freshVault, mintToken, op, refused } from "./helpers.ts";

async function fixture() {
  const vault = freshVault("shapes");
  const token = await mintToken({ vault, scopes: `vault:${vault}:write vault:${vault}:read` });
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await SELF.fetch(`${base(vault)}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as any;
  };
  /** The vault's create-record counters, summed over days and versions (health.ts keys `subject|outcome`). */
  const counters = async () => {
    const res = await op(vault, "/api/internal/health?since=2000-01-01");
    expect(res.status).toBe(200);
    const out: Record<string, number> = {};
    const body = (await res.json()) as { days: Record<string, Record<string, Record<string, number>>> };
    for (const versions of Object.values(body.days)) for (const keys of Object.values(versions)) for (const [k, n] of Object.entries(keys)) {
      if (k.startsWith("mcp:create-record|")) out[k] = (out[k] ?? 0) + n;
    }
    return out;
  };
  return { vault, call, counters };
}

describe("create-record with a wrongly shaped argument (T-476)", () => {
  it("a link with no relationship to a record that exists is refused, nothing is written, and it is not a server fault", async () => {
    const f = await fixture();
    expect((await f.call("create-record", { path: "People/Ada", body: "Ada" })).result.isError).toBeFalsy();
    const body = await f.call("create-record", { path: "Notes/Garden", body: "See Ada.", links: [{ target: "People/Ada" }] });
    const r = refused(body, "invalid_query");
    expect(r.field).toBe("links.0.relationship");
    // Before the fix the record was written and then the link crashed.
    refused(await f.call("query-records", { id: "Notes/Garden" }), "not_found");
    const c = await f.counters();
    expect(Object.keys(c).filter((k) => k.includes("exception:"))).toEqual([]);
    expect(c["mcp:create-record|ok"]).toBe(1);
  });

  it("the other shapes that crashed are refused too", async () => {
    const f = await fixture();
    await f.call("create-record", { path: "People/Ada", body: "Ada" });
    // Each its own path: on the old engine a crash that had already written a shared path turned the next shape
    // into a path_conflict, so it proved nothing.
    const shapes: [Record<string, unknown>, string][] = [
      [{ path: 5, body: "x" }, "path"],
      [{ path: "S/body", body: ["x"] }, "body"],
      [{ path: "S/tags", tags: [null] }, "tags"],
      [{ path: "S/links", links: ["People/Ada"] }, "links.0"],
      [{ path: "S/target", links: [{ target: 5, relationship: "r" }] }, "links.0.target"],
      [{ records: { path: "S/records" } }, "records"],
      [{ records: [{ path: "S/item" }, null] }, "records"],
    ];
    for (const [args, field] of shapes) expect(refused(await f.call("create-record", args), "invalid_query").field, JSON.stringify(args)).toBe(field);
    for (const id of ["S/body", "S/tags", "S/links", "S/target", "S/records", "S/item"]) refused(await f.call("query-records", { id }), "not_found");
    const c = await f.counters();
    expect(Object.keys(c).filter((k) => k.includes("exception:"))).toEqual([]);
  });
});
