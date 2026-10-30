/**
 * Durable Object SQLite refuses a LIKE/GLOB pattern over 50 bytes ("LIKE or
 * GLOB pattern too complex"). T-36 fixed the wikilink queries; these cover the
 * other LIKE queries in core that bind a caller-supplied value: path_prefix,
 * exclude_path_prefix and the tag-rename cascade. They run in workerd, which
 * enforces the same cap as production.
 */
import { env, runInDurableObject } from "cloudflare:test";
import type { DurableObject } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createNote, freshVault, op } from "./helpers.ts";

const bytes = (s: string) => new TextEncoder().encode(s).length;
// A folder name a person would plausibly use, 60+ bytes with the slash.
const folder = (v: string) => `Meetings with the whole friends group about the move ${v}/`;

async function paths(v: string, q: string): Promise<{ status: number; body: any }> {
  const res = await op(v, `/api/notes?${q}`);
  const text = await res.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch {}
  return { status: res.status, body };
}

describe("LIKE patterns over 50 bytes outside wikilinks", () => {
  it("path_prefix with a long folder returns the notes under it", async () => {
    const v = freshVault("pfx");
    const dir = folder(v);
    expect(bytes(dir)).toBeGreaterThan(49);
    await createNote(v, { path: `${dir}one`, content: "inside" });
    await createNote(v, { path: "elsewhere/two", content: "outside" });
    const r = await paths(v, `path_prefix=${encodeURIComponent(dir)}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const list = Array.isArray(r.body) ? r.body : r.body.notes;
    expect(list.map((n: any) => n.path)).toEqual([`${dir}one`]);
  });

  it("exclude_path_prefix with a long folder drops the notes under it", async () => {
    const v = freshVault("xpfx");
    const dir = folder(v);
    await createNote(v, { path: `${dir}one`, content: "inside" });
    await createNote(v, { path: "elsewhere/two", content: "outside" });
    const r = await paths(v, `exclude_path_prefix=${encodeURIComponent(dir)}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const list = (Array.isArray(r.body) ? r.body : r.body.notes).map((n: any) => n.path);
    // The fresh vault also holds its welcome notes; only the folder must go.
    expect(list).toContain("elsewhere/two");
    expect(list).not.toContain(`${dir}one`);
  });

  it("renaming a tag with a long sub-tag succeeds", async () => {
    const v = freshVault("rtag");
    const sub = `proj/meetings-with-the-whole-friends-group-about-the-move`;
    expect(bytes(sub)).toBeGreaterThan(48);
    await createNote(v, { content: `body #${sub}`, tags: [sub] });
    await createNote(v, { content: "root", tags: ["proj"] });
    const res = await op(v, `/api/tags/proj/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ new_name: "project" }),
    });
    const text = await res.text();
    expect(res.status, text).toBe(200);
    expect(JSON.parse(text).sub_tags_renamed).toBe(1);
  });

  it("renaming a tag with 50 short sub-tags succeeds (100 bound params per statement)", async () => {
    const v = freshVault("rmany");
    const subs = Array.from({ length: 50 }, (_, i) => `person/p${i}`);
    await createNote(v, { content: "people", tags: ["person", ...subs] });
    const res = await op(v, `/api/tags/person/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ new_name: "people" }),
    });
    const text = await res.text();
    expect(res.status, text).toBe(200);
    expect(JSON.parse(text).sub_tags_renamed).toBe(50);
  });

  it("renaming a long tag rewrites the parent_names that name it", async () => {
    // The parent_names pre-filter inlined `LIKE '%"<name>"%'`, so it trips the
    // cap once any tag row has parent_names set.
    const v = freshVault("rparent");
    const parent = "area/meetings-with-the-whole-friends-group-about-it";
    expect(bytes(parent)).toBeGreaterThan(46);
    await createNote(v, { content: "x", tags: [parent, "child"] });
    const stub = env.VAULT.get(env.VAULT.idFromName(v));
    await runInDurableObject<DurableObject, void>(stub, async (inst: any) => {
      await inst.store.upsertTagRecord("child", { parent_names: [parent] });
    });
    const res = await op(v, `/api/tags/${encodeURIComponent(parent)}/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ new_name: "area/short" }),
    });
    const text = await res.text();
    expect(res.status, text).toBe(200);
    expect(JSON.parse(text).parent_refs_updated).toBe(1);
    const parents = await runInDurableObject<DurableObject, string[]>(stub, async (inst: any) =>
      JSON.parse((inst.store.db.prepare("SELECT parent_names FROM tags WHERE name = 'child'").get() as any).parent_names),
    );
    expect(parents).toEqual(["area/short"]);
  });
});
