/**
 * B9 D.7, vault41d91be routes.ts:1211-1243.
 * P1–P3: src/vault.test.ts:2659-2686; P4/P9 core.test.ts:552-569.
 * P5/P6/P8 share the addressing helper; P7 routes.ts:4002,4007.
 * P10 cloud REST/MCP twin, core/src/mcp.ts:199-203.
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { base, freshVault, createNote, op, mintToken } from "./helpers.ts";
async function request(v: string, path: string, method = "GET", body?: any) {
  const r = await op(v, path, {
    method,
    ...(body
      ? {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });
  return {
    status: r.status,
    headers: r.headers,
    body: (await r.json()) as any,
  };
}
async function get(v: string, q: string) {
  const r = await request(v, `/api/notes?${q}`);
  expect(r.status).toBe(200);
  return r.body;
}
async function post(v: string, body: any) {
  const r = await request(v, "/api/notes", "POST", body);
  expect(r.status).toBe(201);
  return r.body;
}
async function patch(v: string, id: string, body: any) {
  const r = await request(v, `/api/notes/${encodeURIComponent(id)}`, "PATCH", {
    force: true,
    ...body,
  });
  expect(r.status).toBe(200);
  return r.body;
}
async function call(v: string, name: string, args: any) {
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
      params: { name, arguments: args },
    }),
  });
  expect(r.status).toBe(200);
  const b = (await r.json()) as any;
  expect(b.error).toBeUndefined();
  return JSON.parse(b.result.content[0].text);
}
async function titleFixture() {
  const v = freshVault("b9title"),
    title = `My Great Note-${v}`,
    path = `Inbox/${v}-xyz`;
  const n = await createNote(v, { path, content: `# ${title}` });
  return { v, title, path, n };
}
describe("B9 D.7 addressing", () => {
  it("P1 Probe B path GET title", async () => {
    const f = await titleFixture(),
      r = await request(f.v, `/api/notes/${encodeURIComponent(f.title)}`);
    expect(r.status).toBe(200);
    expect(r.body.path).toBe(f.path);
  });
  it("P2 exact path wins", async () => {
    const f = await titleFixture();
    const n = await createNote(f.v, { path: f.title, content: "path winner" });
    const r = await request(f.v, `/api/notes/${encodeURIComponent(f.title)}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: n.id, content: "path winner" });
  });
  it("P3 duplicate H1 stays not found", async () => {
    const f = await titleFixture();
    await createNote(f.v, { path: `${f.v}/other`, content: `# ${f.title}` });
    const r = await request(f.v, `/api/notes/${encodeURIComponent(f.title)}`);
    expect(r.status).toBe(404);
    expect(r.body.error_type).toBe("not_found");
  });
  it("P4 query id title", async () => {
    const f = await titleFixture();
    expect((await get(f.v, `id=${encodeURIComponent(f.title)}`)).id).toBe(
      f.n.id,
    );
  });
  it("P5 PATCH title", async () => {
    const f = await titleFixture();
    await patch(f.v, f.title, { content: "edited" });
    expect((await get(f.v, `id=${f.n.id}`)).content).toBe("edited");
  });
  it("P6 DELETE title", async () => {
    const f = await titleFixture();
    const r = await request(
      f.v,
      `/api/notes/${encodeURIComponent(f.title)}`,
      "DELETE",
    );
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ deleted: true, id: f.n.id });
  });
  it("P7 find-path title", async () => {
    const f = await titleFixture();
    const b = await createNote(f.v, { path: `${f.v}/b`, content: "target" });
    await patch(f.v, f.n.id, {
      links: { add: [{ target: b.id, relationship: "knows" }] },
    });
    const r = await request(
      f.v,
      `/api/find-path?source=${encodeURIComponent(f.title)}&target=${encodeURIComponent(b.path)}`,
    );
    expect(r.status).toBe(200);
    expect(r.body).not.toBeNull();
    expect(r.body.path).toEqual([f.n.id, b.id]);
  });
  it("P8 near title", async () => {
    const f = await titleFixture();
    const b = await createNote(f.v, { path: `${f.v}/b`, content: "target" });
    await patch(f.v, f.n.id, {
      links: { add: [{ target: b.id, relationship: "knows" }] },
    });
    const rows = await get(
      f.v,
      `near[note_id]=${encodeURIComponent(f.title)}&limit=500`,
    );
    expect(rows.map((n: any) => n.id)).toEqual(
      expect.arrayContaining([f.n.id, b.id]),
    );
  });
  it("P9 title case and real miss", async () => {
    const f = await titleFixture();
    const r = await request(
      f.v,
      `/api/notes/${encodeURIComponent(f.title.toLowerCase())}`,
    );
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(f.n.id);
    const miss = await request(f.v, `/api/notes/Nothing-Like-This-${f.v}`);
    expect(miss.status).toBe(404);
    expect(miss.body.error_type).toBe("not_found");
  });
  it("P10 REST MCP title twin", async () => {
    const f = await titleFixture();
    const m = await call(f.v, "query-notes", { id: f.title });
    expect((await get(f.v, `id=${encodeURIComponent(f.title)}`)).id).toBe(m.id);
  });
});

/**
 * D.8 twins at vault41d91be: P11/P17 vault.test.ts:5786-5798,
 * core.test.ts:2898-2920; P12 vault.test.ts:5802-5820/core:2877-2893;
 * P13–P15 vault.test.ts:5824-5876/core:2948-3034; P16 vault:5772-5784;
 * P18 vault:5878-5901; P19 vault:5903-5918; P20 routes.ts:2913-2922;
 * P21/P22 routes.ts:3097-3098 and wikilinks.ts:1560-1572;
 * P23 vault:5781; P23b/P23c lean warnings match routes.ts:3303,2954 (spec11.6).
 * P24 is the cloud REST/MCP twin of core/src/mcp.ts:1656,1674.
 * P25 body-only warnings matches routes.ts:2528-2534.
 * P26 standing scope/transaction suites stay unchanged; P27 is only the
 * B7 comment correction. P28 ignore core.test.ts:7704-7725.
 */
async function outgoing(v: string, id: string) {
  const n = await get(v, `id=${id}&include_links=true`);
  return n.links.filter((l: any) => l.sourceId === id);
}
function warning(n: any, code: string, target: string, relationship: string) {
  expect(n.warnings).toHaveLength(1);
  expect(n.warnings[0]).toMatchObject({ code, target, relationship });
}
async function ambiguous() {
  const v = freshVault("b9amb"),
    target = `Dup-${v}`;
  await createNote(v, { path: `a/${target}`, content: "a" });
  await createNote(v, { path: `b/${target}`, content: "b" });
  return { v, target };
}
describe("B9 D.8 link queue and warnings", () => {
  it("P11 Probe A queued structured link backfills", async () => {
    const v = freshVault("b9queue"),
      target = `Not Yet Real-${v}`;
    const n = await post(v, {
      path: `${v}/src`,
      content: "x",
      links: [{ target, relationship: "wants" }],
    });
    warning(n, "unresolved_link", target, "wants");
    const t = await createNote(v, { path: target, content: "target" });
    expect(await outgoing(v, n.id)).toEqual([
      expect.objectContaining({ targetId: t.id, relationship: "wants" }),
    ]);
  });
  it("P12 later batch sibling resolves without warnings", async () => {
    const v = freshVault("b9batch"),
      target = `${v}/B`;
    const ns = await post(v, {
      notes: [
        {
          path: `${v}/A`,
          content: `see [[${target}]]`,
          links: [{ target, relationship: "knows" }],
        },
        { path: target, content: "target" },
      ],
    });
    expect("warnings" in ns[0]).toBe(false);
    const edges = await outgoing(v, ns[0].id);
    expect(edges.filter((l: any) => l.relationship === "knows")).toEqual([
      expect.objectContaining({ targetId: ns[1].id }),
    ]);
    expect(edges.filter((l: any) => l.relationship === "wikilink")).toEqual([
      expect.objectContaining({ targetId: ns[1].id }),
    ]);
  });
  it("P13 content miss warns", async () => {
    const v = freshVault("b9content"),
      target = `Missing-${v}`;
    warning(
      await post(v, { path: `${v}/w`, content: `see [[${target}]]` }),
      "unresolved_link",
      target,
      "wikilink",
    );
  });
  it("P14 content ambiguity warns without edge", async () => {
    const f = await ambiguous();
    const n = await post(f.v, { content: `see [[${f.target}]]` });
    warning(n, "ambiguous_link", f.target, "wikilink");
    expect(n.warnings[0].candidate_count).toBe(2);
    expect(await outgoing(f.v, n.id)).toHaveLength(0);
  });
  it("P15 structured ambiguity is discoverable", async () => {
    const f = await ambiguous();
    const n = await post(f.v, {
      path: `${f.v}/source`,
      content: "x",
      links: [{ target: f.target, relationship: "mentions" }],
    });
    warning(n, "ambiguous_link", f.target, "mentions");
    expect(n.warnings[0].candidate_count).toBe(2);
    expect(await outgoing(f.v, n.id)).toHaveLength(0);
    const rows = await get(
      f.v,
      `has_ambiguous_links=true&path_prefix=${f.v}&limit=500`,
    );
    expect(rows.map((n: any) => n.id)).toContain(n.id);
  });
  it("P16 PATCH basename resolves", async () => {
    const v = freshVault("b9base"),
      target = `Bob-${v}`,
      t = await createNote(v, { path: `People/${target}`, content: "x" }),
      n = await createNote(v, { path: `${v}/src`, content: "x" });
    const b = await patch(v, n.id, {
      links: { add: [{ target, relationship: "knows" }] },
    });
    expect(b.warnings).toBeUndefined();
    expect(await outgoing(v, n.id)).toEqual([
      expect.objectContaining({ targetId: t.id, relationship: "knows" }),
    ]);
  });
  it("P17 PATCH miss backfills", async () => {
    const v = freshVault("b9patch"),
      target = `Not Yet Real-${v}`,
      n = await createNote(v, { path: `${v}/src`, content: "x" });
    warning(
      await patch(v, n.id, {
        links: { add: [{ target, relationship: "wants" }] },
      }),
      "unresolved_link",
      target,
      "wants",
    );
    const t = await createNote(v, { path: target, content: "target" });
    expect(await outgoing(v, n.id)).toEqual([
      expect.objectContaining({ targetId: t.id, relationship: "wants" }),
    ]);
  });
  it("P18 content warns but tags-only does not rewarn", async () => {
    const v = freshVault("b9patch"),
      target = `Missing-${v}`;
    await createNote(v, { path: `${v}/tagseed`, content: "x", tags: [v] });
    const n = await createNote(v, { path: `${v}/src`, content: "x" });
    warning(
      await patch(v, n.id, { content: `see [[${target}]]` }),
      "unresolved_link",
      target,
      "wikilink",
    );
    expect(
      (await patch(v, n.id, { tags: { add: [v] } })).warnings,
    ).toBeUndefined();
  });
  it("P19 missing-create content warns", async () => {
    const v = freshVault("b9missing"),
      target = `Missing-${v}`;
    const b = await patch(v, `${v}-new`, {
      if_missing: "create",
      content: `see [[${target}]]`,
    });
    expect(b.created).toBe(true);
    warning(b, "unresolved_link", target, "wikilink");
  });
  it("P20 missing-create structured miss backfills", async () => {
    const v = freshVault("b9missing"),
      target = `Not Yet Real-${v}`;
    const b = await patch(v, `${v}-new`, {
      if_missing: "create",
      links: { add: [{ target, relationship: "wants" }] },
    });
    expect(b.created).toBe(true);
    warning(b, "unresolved_link", target, "wants");
    const t = await createNote(v, { path: target, content: "target" });
    expect(await outgoing(v, b.id)).toEqual([
      expect.objectContaining({ targetId: t.id, relationship: "wants" }),
    ]);
  });
  it("P21 removal never queues", async () => {
    const v = freshVault("b9remove"),
      n = await createNote(v, { path: `${v}/src`, content: "x" });
    const before = await get(v, `id=${n.id}&include_broken_links=true`);
    const b = await patch(v, n.id, {
      links: {
        remove: [{ target: `Never-Existed-${v}`, relationship: "wikilink" }],
      },
    });
    expect("warnings" in b).toBe(false);
    expect(
      (await get(v, `id=${n.id}&include_broken_links=true`)).broken_links,
    ).toEqual(before.broken_links);
  });
  it("P22 removal resolves H1", async () => {
    const v = freshVault("b9remove"),
      title = `Removable-${v}`,
      t = await createNote(v, { path: `Inbox/${v}-r`, content: `# ${title}` });
    const n = await post(v, {
      path: `${v}/src`,
      content: "x",
      links: [{ target: t.id, relationship: "mentions" }],
    });
    expect(await outgoing(v, n.id)).toHaveLength(1);
    await patch(v, n.id, {
      links: { remove: [{ target: title, relationship: "mentions" }] },
    });
    expect(await outgoing(v, n.id)).toHaveLength(0);
  });
  it("P23 clean writes omit warnings", async () => {
    const v = freshVault("b9clean"),
      t = await createNote(v, { path: `${v}/target`, content: "x" });
    const a = await post(v, {
        content: "x",
        links: [{ target: t.id, relationship: "knows" }],
      }),
      b = await post(v, { content: `[[${t.path}]]` }),
      c = await patch(v, a.id, {
        links: { add: [{ target: t.id, relationship: "mentions" }] },
      });
    for (const n of [a, b, c]) expect("warnings" in n).toBe(false);
  });
  it("P23b lean PATCH carries warnings", async () => {
    const v = freshVault("b9lean"),
      n = await createNote(v, { path: `${v}/src`, content: "x" });
    const b = await patch(v, n.id, {
      content: `[[Missing-${v}]]`,
      include_content: false,
    });
    expect("content" in b).toBe(false);
    warning(b, "unresolved_link", `Missing-${v}`, "wikilink");
  });
  it("P23c lean create-on-missing carries warnings", async () => {
    const v = freshVault("b9leancreate");
    const b = await patch(v, `${v}-absent`, {
      if_missing: "create",
      content: `see [[Missing-${v}]]`,
      include_content: false,
    });
    expect(b.created).toBe(true);
    expect("content" in b).toBe(false);
    warning(b, "unresolved_link", `Missing-${v}`, "wikilink");
  });
  it("P24 REST MCP warnings twin", async () => {
    const v = freshVault("b9twin"),
      args = {
        content: "x",
        links: [{ target: `Nope-${v}`, relationship: "mentions" }],
      };
    const a = await post(v, args),
      b = await call(v, "create-note", args);
    const project = (n: any) =>
      n.warnings.map(({ code, target, relationship }: any) => ({
        code,
        target,
        relationship,
      }));
    expect(project(a)).toEqual(project(b));
  });
  it("P25 body not header", async () => {
    const v = freshVault("b9header"),
      target = `Nope-${v}`;
    const r = await request(v, "/api/notes", "POST", {
      content: "x",
      links: [{ target, relationship: "wants" }],
    });
    expect(r.status).toBe(201);
    expect(r.headers.get("X-Parachute-Warnings")).toBeNull();
    warning(r.body, "unresolved_link", target, "wants");
  });
  it("P28 ignore neither queues nor warns", async () => {
    const v = freshVault("b9ignore"),
      path = `${v}/dup`,
      target = `Nope-${v}`;
    const n = await createNote(v, { path, content: `[[Gone-${v}]]` });
    const b = await post(v, {
      path,
      content: "attempted",
      links: [{ target, relationship: "x" }],
      if_exists: "ignore",
    });
    expect(b.existed).toBe(true);
    expect("warnings" in b).toBe(false);
    expect(b.content).toBe(n.content);
    const detail = await get(v, `id=${n.id}&include_broken_links=true`);
    expect(detail.broken_links).toEqual([
      { target: `Gone-${v}`, relationship: "wikilink" },
    ]);
  });
});
