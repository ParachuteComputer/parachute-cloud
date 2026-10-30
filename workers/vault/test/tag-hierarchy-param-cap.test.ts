/**
 * Durable Object SQLite refuses a statement with more than 100 bound params
 * ("too many SQL variables"). A tag query expands the tag to itself plus every
 * declared descendant (tags.parent_names) and core bound one param per member,
 * so querying a tag with 100+ descendants returned 500. Runs in workerd, which
 * enforces the same cap as production.
 */
import { env, runInDurableObject } from "cloudflare:test";
import type { DurableObject } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createNote, freshVault, op } from "./helpers.ts";

describe("tag query over a hierarchy wider than 100 tags", () => {
  it("?tag=<parent> with 101 declared children returns the notes under it", async () => {
    const v = freshVault("hier");
    const kids = Array.from({ length: 101 }, (_, i) => `kid${i}`);
    const a = await createNote(v, { content: "on a kid", tags: ["kid7"] });
    const b = await createNote(v, { content: "on the hub", tags: ["hub", ...kids] });
    await runInDurableObject<DurableObject, void>(env.VAULT.get(env.VAULT.idFromName(v)), async (inst: any) => {
      for (const k of kids) await inst.store.upsertTagRecord(k, { parent_names: ["hub"] });
    });
    const res = await op(v, `/api/notes?tag=hub`);
    const text = await res.text();
    expect(res.status, text).toBe(200);
    const body = JSON.parse(text);
    const ids = (Array.isArray(body) ? body : body.notes).map((n: any) => n.id);
    expect(ids.sort()).toEqual([a.id, b.id].sort());
  });
});
