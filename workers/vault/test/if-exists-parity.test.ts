/**
 * B8, vault 41d91be: routes.ts:2229-2404,2496-2560.
 * P1–P13 twins: src/vault.test.ts:6470-6547,6591-6628;
 * core/src/core.test.ts:7658-7840,7935-7975.
 * P14/P15 shared paths.ts:18-35 and notes.ts:173-186 (cloud-only pins).
 * P16 core.test.ts:7841-7856; P17 deliberately preserves unvalidated enum
 * fallthrough, routes.ts:2347-2348. P18 core.test.ts:7893-7930.
 * P19/P20 core.test.ts:7858-7892 (NO cloud rollback assertion).
 * P21 core.test.ts:8008-8023; P22 vault.test.ts:6482-6501.
 * P23 proves outcome (one insert, shared id), whichever branch the loser
 * took. HTTP SELF.fetch cannot monkeypatch the DO store as upstream
 * vault.test.ts:2206-2231 does; the (path,extension) unique key admits no
 * input that makes the proactive check miss while the insert conflicts.
 * The backstop's RED proof is upstream vault.test.ts:2234-2270 and
 * core/src/mcp.ts:1614-1628; this pin does not isolate that branch.
 * P24 vault.test.ts:5360-5374. P25/P26 cloud REST/MCP twins of
 * core/src/mcp.ts:1585 and core.test.ts:7825-7831.
 * P27 is the UNEDITED scoped-tags-claim, allowed-issuers, and conformance
 * suites (txn intercepts 0/2), checked by the full suite, not duplicated here.
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { base, freshVault, op, createNote, mintToken } from "./helpers.ts";
async function post(v: string, body: any) {
  const r = await op(v, "/api/notes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as any };
}
async function ok(v: string, body: any) {
  const r = await post(v, body);
  expect(r.status).toBe(201);
  return r.body;
}
async function get(v: string, id: string) {
  const r = await op(v, `/api/notes?id=${id}`);
  expect(r.status).toBe(200);
  return (await r.json()) as any;
}
async function rows(v: string, path: string) {
  const r = await op(
    v,
    `/api/notes?path=${encodeURIComponent(path)}&limit=500`,
  );
  expect(r.status).toBe(200);
  return (await r.json()) as any[];
}
async function fixture(extra: any = {}) {
  const v = freshVault("upsert"),
    path = `${v}/dup`;
  const first = await createNote(v, {
    path,
    content: "original",
    metadata: { v: 1 },
    ...extra,
  });
  return { v, path, first };
}
async function schema(v: string, tag: string, fields: any) {
  const token = await mintToken({ vault: v, scopes: `vault:${v}:admin` });
  const r = await SELF.fetch(`${base(v)}/api/tags/${tag}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields }),
  });
  expect(r.status).toBe(200);
}
async function call(v: string, args: any) {
  const token = await mintToken({
    vault: v,
    scopes: `vault:${v}:read vault:${v}:write`,
  });
  const r = await SELF.fetch(`${base(v)}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "create-note", arguments: args },
    }),
  });
  expect(r.status).toBe(200);
  const b = (await r.json()) as any;
  expect(b.error).toBeUndefined();
  return JSON.parse(b.result.content[0].text);
}
describe("B8 if_exists parity", () => {
  it("P1 default conflict", async () => {
    const f = await fixture();
    const r = await post(f.v, { path: f.path, content: "second" });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error_type: "path_conflict", path: f.path });
    expect("existed" in r.body).toBe(false);
  });
  it("P2 explicit error", async () => {
    const f = await fixture();
    const r = await post(f.v, { path: f.path, if_exists: "error" });
    expect(r.status).toBe(409);
    expect(r.body.error_type).toBe("path_conflict");
    expect("existed" in r.body).toBe(false);
  });
  it("P3 Probe A ignore", async () => {
    const f = await fixture();
    const b = await ok(f.v, {
      path: f.path,
      content: "attempted",
      metadata: { v: 2 },
      if_exists: "ignore",
    });
    expect(b).toMatchObject({
      id: f.first.id,
      content: "original",
      metadata: { v: 1 },
      existed: true,
    });
  });
  it("P4 ignore skips defaults", async () => {
    const v = freshVault("upsert"),
      tag = `${v}-task`,
      path = `${v}/old`;
    await schema(v, tag, {});
    const n = await createNote(v, { path, content: "old", tags: [tag] });
    // Approved P4-only exception to schema-first fixtures: the note MUST
    // predate the default (core.test.ts:7704-7725); that ordering is the pin.
    await schema(v, tag, {
      priority: { type: "string", enum: ["high", "low"], default: "high" },
    });
    const before = await get(v, n.id);
    expect(before.metadata.priority).toBeUndefined();
    const b = await ok(v, { path, if_exists: "ignore" });
    expect(b.existed).toBe(true);
    expect(b.metadata.priority).toBeUndefined();
    expect(b.updatedAt).toBe(before.updatedAt);
    expect((await get(v, n.id)).metadata.priority).toBeUndefined();
  });
  it("P5 update merges metadata and tags", async () => {
    const v = freshVault("upsert"),
      path = `${v}/x`,
      a = `${v}-a`,
      b = `${v}-b`;
    await schema(v, a, {});
    await schema(v, b, {});
    await createNote(v, {
      path,
      content: "old",
      metadata: { keep: 1, drop: 2 },
      tags: [a],
    });
    const n = await ok(v, {
      path,
      content: "new",
      metadata: { drop: null, add: 3 },
      tags: [b],
      if_exists: "update",
    });
    expect(n.existed).toBe(true);
    expect(n.content).toBe("new");
    expect(n.metadata).toEqual({ keep: 1, add: 3 });
    expect(n.tags).toEqual(expect.arrayContaining([a, b]));
  });
  it("P6 update omission preserves content", async () => {
    const f = await fixture();
    const b = await ok(f.v, {
      path: f.path,
      metadata: { add: 1 },
      if_exists: "update",
    });
    expect(b.content).toBe(f.first.content);
  });
  it("P7 replace preserves identity and additive tags", async () => {
    const v = freshVault("upsert"),
      path = `${v}/x`,
      a = `${v}-a`,
      b = `${v}-b`;
    await schema(v, a, {});
    await schema(v, b, {});
    const n = await createNote(v, {
      path,
      content: "old",
      metadata: { keep: 1 },
      tags: [a],
    });
    const r = await ok(v, {
      path,
      content: "new",
      metadata: { only: 2 },
      tags: [b],
      if_exists: "replace",
    });
    expect(r).toMatchObject({
      id: n.id,
      createdAt: n.createdAt,
      content: "new",
      existed: true,
    });
    expect(r.metadata).toEqual({ only: 2 });
    expect(r.tags).toEqual(expect.arrayContaining([a, b]));
  });
  it("P8 replace omissions clear fields", async () => {
    const f = await fixture();
    const b = await ok(f.v, { path: f.path, if_exists: "replace" });
    expect(b.content).toBe("");
    expect(b.metadata).toEqual({});
  });
  it("P9 Probe B fresh flag", async () => {
    const v = freshVault("upsert");
    const b = await ok(v, {
      path: `${v}/new`,
      content: "fresh",
      if_exists: "update",
    });
    expect(b.existed).toBe(false);
  });
  it("P10 default has no flag", async () => {
    const v = freshVault("upsert");
    expect(
      "existed" in (await ok(v, { path: `${v}/plain`, content: "x" })),
    ).toBe(false);
  });
  it("P11 pathless remains fresh", async () => {
    const v = freshVault("upsert");
    const a = await ok(v, { content: "one", if_exists: "ignore" }),
      b = await ok(v, { content: "one", if_exists: "ignore" });
    expect(a.id).not.toBe(b.id);
    expect(a.existed).toBe(false);
    expect(b.existed).toBe(false);
  });
  it("P12 tags-only update advances timestamp", async () => {
    const v = freshVault("upsert"),
      tag = `${v}-beta`,
      path = `${v}/x`;
    await schema(v, tag, {});
    const n = await createNote(v, { path, content: "x" });
    await new Promise((r) => setTimeout(r, 5));
    const b = await ok(v, { path, tags: [tag], if_exists: "update" });
    expect(b.tags).toContain(tag);
    expect((await get(v, n.id)).updatedAt > n.updatedAt).toBe(true);
  });
  it("P13 links-only update advances timestamp", async () => {
    const f = await fixture();
    const target = await createNote(f.v, {
      path: `${f.v}/target`,
      content: "x",
    });
    await new Promise((r) => setTimeout(r, 5));
    await ok(f.v, {
      path: f.path,
      links: [{ target: target.id, relationship: "relates-to" }],
      if_exists: "update",
    });
    expect((await get(f.v, f.first.id)).updatedAt > f.first.updatedAt).toBe(
      true,
    );
  });
  it("P14 normalized path collision", async () => {
    const f = await fixture();
    for (const path of [f.path + ".md", "/" + f.path])
      expect(await ok(f.v, { path, if_exists: "ignore" })).toMatchObject({
        id: f.first.id,
        existed: true,
      });
  });
  it("P15 case insensitive", async () => {
    const v = freshVault("upsert"),
      n = await createNote(v, { path: `${v}/Case`, content: "x" });
    expect(
      await ok(v, { path: `${v}/case`, if_exists: "ignore" }),
    ).toMatchObject({ id: n.id, existed: true });
  });
  it("P16 extension tuple", async () => {
    const v = freshVault("upsert"),
      path = `${v}/rep`;
    const n = await ok(v, { path, extension: "csv", content: "csv" });
    await ok(v, { path, extension: "md", content: "md" });
    expect(
      await ok(v, {
        path,
        extension: "csv",
        content: "attempted",
        if_exists: "ignore",
      }),
    ).toMatchObject({
      id: n.id,
      extension: "csv",
      content: "csv",
      existed: true,
    });
  });
  it("P17 unknown enum preserves error semantics", async () => {
    const f = await fixture();
    const r = await post(f.v, { path: f.path, if_exists: "bogus" });
    expect(r.status).toBe(409);
    expect(r.body.error_type).toBe("path_conflict");
    expect("existed" in r.body).toBe(false);
  });
  it("P18 projected schema gating", async () => {
    const v = freshVault("upsert"),
      tag = `${v}-task`,
      path = `${v}/strict`;
    await schema(v, tag, {
      status: {
        type: "string",
        enum: ["open", "done"],
        strict: true,
        required: true,
      },
    });
    const n = await createNote(v, {
      path,
      content: "v1",
      tags: [tag],
      metadata: { status: "open" },
    });
    const before = await get(v, n.id);
    const r = await post(v, {
      path,
      content: "v2",
      metadata: { status: "bad" },
      if_exists: "update",
    });
    expect(r.status).toBe(422);
    expect(r.body.error_type).toBe("schema_validation");
    expect(r.body.violations.length).toBeGreaterThan(0);
    expect(await get(v, n.id)).toEqual(before);
    expect(
      await ok(v, { path, content: "v2", if_exists: "update" }),
    ).toMatchObject({
      content: "v2",
      metadata: { status: "open" },
      existed: true,
    });
  });
  it("P19 top level mode is not inherited", async () => {
    const f = await fixture();
    const r = await post(f.v, {
      if_exists: "ignore",
      notes: [{ path: f.path, content: "conflict" }],
    });
    expect(r.status).toBe(409);
    expect(r.body.error_type).toBe("path_conflict");
    expect(r.body.path).toBe(f.path);
  });
  it("P20 mixed batch item order", async () => {
    const v = freshVault("upsert");
    await createNote(v, { path: `${v}/b`, content: "pre-existing" });
    const b = await ok(v, {
      notes: ["a", "b", "c"].map((x) => ({
        path: `${v}/${x}`,
        content: x,
        if_exists: "ignore",
      })),
    });
    expect(b).toHaveLength(3);
    expect(b.map((n: any) => n.existed)).toEqual([false, true, false]);
    expect(b[1].content).toBe("pre-existing");
  });
  it("P21 Probe C summary excludes collisions", async () => {
    const v = freshVault("upsert");
    const old = await createNote(v, {
      path: `${v}/b`,
      content: "pre-existing",
    });
    const b = await ok(v, {
      notes: ["a", "b", "c"].map((x) => ({
        path: `${v}/${x}`,
        content: x,
        if_exists: "ignore",
      })),
      summary: true,
    });
    const ids = [];
    for (const x of ["a", "b", "c"]) {
      const found = await rows(v, `${v}/${x}`);
      expect(found).toHaveLength(1);
      ids.push(found[0].id);
    }
    expect(ids[1]).toBe(old.id);
    expect(b).toEqual({ created: 2, ids, failed: [] });
    expect(b.created).toBe(2);
    expect(b.ids).toHaveLength(3);
  });
  it("P22 sequential retries", async () => {
    const v = freshVault("upsert"),
      path = `${v}/idem`,
      out = [];
    for (let i = 0; i < 3; i++)
      out.push(await ok(v, { path, content: "x", if_exists: "ignore" }));
    expect(new Set(out.map((n) => n.id)).size).toBe(1);
    expect(out.map((n) => n.existed)).toEqual([false, true, true]);
    expect(await rows(v, path)).toHaveLength(1);
  });
  it("P23 concurrent outcome, not isolated backstop", async () => {
    const v = freshVault("upsert"),
      path = `${v}/race`;
    const [a, b] = await Promise.all([
      ok(v, { path, content: "x", if_exists: "ignore" }),
      ok(v, { path, content: "x", if_exists: "ignore" }),
    ]);
    expect(a.id).toBe(b.id);
    expect([a.existed, b.existed].sort()).toEqual([false, true]);
    expect(await rows(v, path)).toHaveLength(1);
  });
  it("P24 unscoped refusal guard is inert", async () => {
    const v = freshVault("upsert"),
      tag = `${v}-tag`;
    const n = await createNote(v, {
      path: `${v}/x`,
      content: "full",
      tags: [tag],
    });
    const b = await ok(v, { path: n.path, if_exists: "ignore" });
    expect(b.existed).toBe(true);
    expect(b.content).toBe("full");
    expect(b.tags).toEqual(n.tags);
  });
  it("P25 REST MCP applied twin", async () => {
    const v = freshVault("upsert");
    for (const x of ["rest", "mcp"])
      await createNote(v, {
        path: `${v}/${x}`,
        content: "old",
        metadata: { keep: 1 },
      });
    const a = await ok(v, {
        path: `${v}/rest`,
        content: "new",
        metadata: { add: 1 },
        if_exists: "update",
      }),
      b = await call(v, {
        path: `${v}/mcp`,
        content: "new",
        metadata: { add: 1 },
        if_exists: "update",
      });
    for (const n of [a, b])
      expect({
        existed: n.existed,
        content: n.content,
        metadata: n.metadata,
      }).toEqual({
        existed: true,
        content: "new",
        metadata: { keep: 1, add: 1 },
      });
  });
  it("P26 REST MCP absence twin", async () => {
    const v = freshVault("upsert"),
      a = await ok(v, { path: `${v}/rest`, content: "x" }),
      b = await call(v, { path: `${v}/mcp`, content: "x" });
    expect("existed" in a).toBe(false);
    expect("existed" in b).toBe(false);
  });
});
