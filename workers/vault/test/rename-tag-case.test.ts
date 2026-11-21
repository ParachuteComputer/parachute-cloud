/**
 * Tag names are case-sensitive (`Work` and `work` are two tags), but core's
 * rename-tag picked the sub-tags to carry along with an ASCII-case-insensitive
 * prefix. On the cloud door, renaming `Work` also moved `work/sub` (a child of
 * the separate tag `work`) and rewrote `#work/sub` in its notes; with both
 * `Work/sub` and `work/sub` present the rename failed with a 500 (UNIQUE
 * constraint). Red until the core pin carries the fix (parachute-core
 * uni/t318-dr2-rename-case).
 */
import { describe, expect, it } from "vitest";
import { createNote, freshVault, op } from "./helpers.ts";

async function rename(v: string, from: string, to: string): Promise<{ status: number; text: string }> {
  const res = await op(v, `/api/tags/${encodeURIComponent(from)}/rename`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ new_name: to }),
  });
  return { status: res.status, text: await res.text() };
}

async function noteById(v: string, id: string): Promise<any> {
  const res = await op(v, `/api/notes/${encodeURIComponent(id)}`);
  return res.json();
}

describe("rename-tag sub-tags match the old name's case exactly (DO SQLite)", () => {
  it("renaming `Work` leaves `work/sub` and its notes alone", async () => {
    const v = freshVault("rcase");
    await createNote(v, { content: "a #Work", tags: ["Work"] });
    const other = await createNote(v, { content: "c #work/sub", tags: ["work/sub"] });
    const r = await rename(v, "Work", "Job");
    expect(r.status, r.text).toBe(200);
    expect(JSON.parse(r.text).sub_tags_renamed).toBe(0);
    const back = await noteById(v, other.id);
    expect(back.content).toBe("c #work/sub");
    expect(back.tags).toEqual(["work/sub"]);
  });

  it("renaming `Work` succeeds when both `Work/sub` and `work/sub` exist", async () => {
    const v = freshVault("rcoll");
    await createNote(v, { content: "a #Work/sub", tags: ["Work", "Work/sub"] });
    await createNote(v, { content: "c #work/sub", tags: ["work/sub"] });
    const r = await rename(v, "Work", "Job");
    expect(r.status, r.text).toBe(200);
    expect(JSON.parse(r.text).sub_tags_renamed).toBe(1);
  });
});
