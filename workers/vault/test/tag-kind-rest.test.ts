/**
 * Core 0.9 (T-318 §8a): "writes accept both". The bun vault's REST takes `types` on POST /api/notes and PATCH
 * /api/notes/:id (folded into the tags, a plain tag refused with 422 tag_kind), and `kind` on PUT /api/tags/:name.
 * Cloud's REST is its own twin of those routes; on the 0.9 engine it must not answer 201/200 while dropping them:
 * a note created with `types: ["meeting"]` must carry the tag, and `kind: "type"` must make a type.
 */
import { describe, expect, it } from "vitest";
import { createNote, freshVault, op } from "./helpers.ts";

const JSON_HEADERS = { "Content-Type": "application/json" };
const send = (v: string, path: string, method: string, body: unknown) =>
  op(v, path, { method, headers: JSON_HEADERS, body: JSON.stringify(body) });

describe("REST writes take 0.9 types and kind, as bun's REST does", () => {
  it("POST /api/notes with types lands the type; PATCH types {add} adds one", async () => {
    const v = freshVault("tkrest");
    const made = await createNote(v, { path: "m/one", content: "One", types: ["meeting"] });
    expect(made.tags).toContain("meeting");
    expect(made.types).toEqual(["meeting"]);
    const got = (await (await op(v, `/api/notes/${made.id}`)).json()) as any;
    expect(got.tags).toContain("meeting");

    const other = await createNote(v, { path: "m/two", content: "Two" });
    const patched = await send(v, `/api/notes/${other.id}`, "PATCH", { types: { add: ["meeting"] }, force: true });
    expect(patched.status).toBe(200);
    const after = (await (await op(v, `/api/notes/${other.id}`)).json()) as any;
    expect(after.tags).toContain("meeting");
    expect(after.types).toEqual(["meeting"]);
  });

  it("a plain tag named in types is refused with the fix, not dropped", async () => {
    const v = freshVault("tkrest2");
    await createNote(v, { path: "l/one", content: "x", tags: ["label"] });
    const res = await send(v, "/api/notes", "POST", { path: "l/two", content: "y", types: ["label"] });
    expect(res.status).toBe(422);
    expect(((await res.json()) as any).error_type).toBe("tag_kind");
  });

  it("PUT /api/tags/:name {kind: \"type\"} makes a type", async () => {
    const v = freshVault("tkrest3");
    await createNote(v, { path: "p/alder", content: "Alder", tags: ["project"] });
    const res = await send(v, "/api/tags/project", "PUT", { kind: "type" });
    expect(res.status).toBe(200);
    const made = await createNote(v, { path: "p/birch", content: "Birch", types: ["project"] });
    expect(made.types).toEqual(["project"]);
  });
});
