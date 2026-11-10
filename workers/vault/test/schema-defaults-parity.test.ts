/**
 * T-437: a field a note never set stays ABSENT (vault#553, HTTP_API.md "`default` is now the ONLY way to backfill a
 * field"). Only a declared `default` backfills; an enum without one is not filled with its first value, and a field
 * of any other type is not filled with "" / 0 / false. The box's REST (src/routes.ts) and every door's MCP use core's
 * `applySchemaDefaults`; this door's REST used to carry its own pre-0.7 copy, so an indexed `date` left unset read
 * back as "" and every later PATCH of the note failed 422 (`type_mismatch`). Each REST write that applies defaults is
 * covered: POST (single and batch), PATCH `tags.add`, PATCH `if_missing: "create"`, POST `if_exists: "update"`; MCP
 * create-note is the twin that was already right. The door contract (parachute-core contracts/suites/door/
 * types.test.ts) holds the same rule on every door once its pin moves.
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { base, freshVault, op, createNote, mintToken } from "./helpers.ts";

const FIELDS = {
  kind: { type: "string", enum: ["letter", "session"], default: "session" },
  owner: { type: "string", enum: ["ag", "lena"] },
  note: { type: "string" },
  count: { type: "integer" },
  done: { type: "boolean" },
  due: { type: "date", indexed: true },
};
const UNSET = ["owner", "note", "count", "done", "due"];

async function declare(v: string) {
  const token = await mintToken({ vault: v, scopes: `vault:${v}:admin` });
  const r = await SELF.fetch(`${base(v)}/api/tags/task`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: FIELDS }),
  });
  expect(r.status, await r.clone().text()).toBe(200);
}
async function send(v: string, method: string, path: string, body: unknown) {
  const r = await op(v, path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
}
async function metadata(v: string, id: string): Promise<Record<string, unknown>> {
  const r = await op(v, `/api/notes/${encodeURIComponent(id)}`);
  expect(r.status).toBe(200);
  return ((await r.json()) as any).metadata ?? {};
}
function expectOnlyDefault(meta: Record<string, unknown>) {
  expect(meta.kind).toBe("session");
  for (const f of UNSET) expect(Object.keys(meta), f).not.toContain(f);
}

describe("T-437 unset declared fields stay absent", () => {
  it("POST: unset fields absent, the declared default filled, and a later PATCH succeeds", async () => {
    const v = freshVault("unset");
    await declare(v);
    const made = await createNote(v, { path: "a/unset", content: "x", tags: ["task"] });
    expectOnlyDefault(await metadata(v, made.id));
    const edit = await send(v, "PATCH", `/api/notes/${made.id}`, { content: "edited", if_updated_at: made.updatedAt });
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);
    expectOnlyDefault(await metadata(v, made.id));
    const never = await op(v, `/api/notes?tag=task&meta[due][exists]=false`);
    expect(((await never.json()) as any[]).map((n) => n.path)).toEqual(["a/unset"]);
  });

  it("POST batch", async () => {
    const v = freshVault("unset");
    await declare(v);
    const r = await send(v, "POST", "/api/notes", { notes: [{ path: "b/1", content: "1", tags: ["task"] }, { path: "b/2", content: "2", tags: ["task"] }] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    for (const n of r.body.notes ?? r.body) expectOnlyDefault(await metadata(v, n.id));
  });

  it("PATCH tags.add on a note that already exists", async () => {
    const v = freshVault("unset");
    await declare(v);
    const plain = await createNote(v, { path: "c/plain", content: "y" });
    const r = await send(v, "PATCH", `/api/notes/${plain.id}`, { tags: { add: ["task"] }, if_updated_at: plain.updatedAt });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expectOnlyDefault(await metadata(v, plain.id));
  });

  it("PATCH if_missing: create", async () => {
    const v = freshVault("unset");
    await declare(v);
    const r = await send(v, "PATCH", `/api/notes/${encodeURIComponent("d/new")}`, { if_missing: "create", content: "z", tags: { add: ["task"] } });
    expect([200, 201], JSON.stringify(r.body)).toContain(r.status);
    expectOnlyDefault(await metadata(v, "d/new"));
  });

  it("POST if_exists: update adding the type", async () => {
    const v = freshVault("unset");
    await declare(v);
    const first = await createNote(v, { path: "e/dup", content: "o" });
    const r = await send(v, "POST", "/api/notes", { path: "e/dup", content: "u", tags: ["task"], if_exists: "update" });
    expect([200, 201], JSON.stringify(r.body)).toContain(r.status);
    expectOnlyDefault(await metadata(v, first.id));
  });

  it("MCP create-note (the twin that already used core's backfill)", async () => {
    const v = freshVault("unset");
    await declare(v);
    const token = await mintToken({ vault: v, scopes: `vault:${v}:read vault:${v}:write` });
    const r = await SELF.fetch(`${base(v)}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create-note", arguments: { path: "f/mcp", content: "m", tags: ["task"] } } }),
    });
    expect(r.status).toBe(200);
    const b = (await r.json()) as any;
    expect(b.error).toBeUndefined();
    expectOnlyDefault(await metadata(v, JSON.parse(b.result.content[0].text).id));
  });
});
