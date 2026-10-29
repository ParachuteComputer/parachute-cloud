/**
 * T-36: Durable Object SQLite refuses a LIKE/GLOB pattern over 50 bytes ("LIKE
 * or GLOB pattern too complex"). Core used to resolve a wikilink with
 * `path LIKE '%/' || target`, so any unresolved target over 48 bytes broke the
 * write (500) and every import that carried one (Adam's vault has 2,452).
 * These run in workerd, which enforces the same cap as production.
 */
import { describe, expect, it } from "vitest";
import { createNote, freshVault, op } from "./helpers.ts";

async function brokenLinks(v: string, id: string) {
  const res = await op(v, `/api/notes?id=${encodeURIComponent(id)}&include_broken_links=true`);
  expect(res.status).toBe(200);
  return ((await res.json()) as any).broken_links;
}

// 60+ bytes, well over the 48-byte line.
const longName = (v: string) => `Meeting notes with the whole friends group about the move ${v}`;

describe("T-36 wikilinks over 48 bytes", () => {
  it("a note linking to a long missing path saves, and resolves once the target exists", async () => {
    const v = freshVault("longlink");
    const target = `Projects/${longName(v)}`;
    expect(new TextEncoder().encode(target).length).toBeGreaterThan(48);
    const source = await createNote(v, { content: `see [[${target}]]` });
    expect(await brokenLinks(v, source.id)).toEqual([{ target, relationship: "wikilink" }]);

    await createNote(v, { path: target, content: "the target" });
    expect(await brokenLinks(v, source.id)).toEqual([]);
  });

  it("a long basename link resolves to the one note whose path ends with it", async () => {
    const v = freshVault("longbase");
    const name = longName(v);
    await createNote(v, { path: `Archive/2026/${name}`, content: "deep" });
    const source = await createNote(v, { content: `[[${name}]]` });
    expect(await brokenLinks(v, source.id)).toEqual([]);
  });

  it("a long basename link written first heals when its note appears in a folder", async () => {
    // The heal query swallows SQL errors (returns 0), so a too-long pattern
    // here leaves the link broken forever rather than failing the write.
    const v = freshVault("longheal");
    const name = longName(v);
    const source = await createNote(v, { content: `[[${name}]]` });
    expect(await brokenLinks(v, source.id)).toEqual([{ target: name, relationship: "wikilink" }]);
    await createNote(v, { path: `Archive/2026/${name}`, content: "deep" });
    expect(await brokenLinks(v, source.id)).toEqual([]);
  });

  it("the suffix match is exact: '_' in a target is not a wildcard", async () => {
    const v = freshVault("underscore");
    await createNote(v, { path: `a/x-${v}-name`, content: "x" });
    const source = await createNote(v, { content: `[[_-${v}-name]]` });
    expect(await brokenLinks(v, source.id)).toEqual([{ target: `_-${v}-name`, relationship: "wikilink" }]);
  });
});
