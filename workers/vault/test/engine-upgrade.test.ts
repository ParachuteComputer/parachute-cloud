import { env, runInDurableObject } from "cloudflare:test";
import type { DurableObject } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createNote, freshVault, op } from "./helpers.ts";
import { NewerSchemaError, SCHEMA_VERSION } from "@openparachute/core/src/schema.js";
import { DoSqliteStore } from "../src/store-do.ts";
import { ROLLBACK_ENGINE, ROLLBACK_ENGINE_DDL } from "./fixtures/engine-ddl-f147e34.ts";

/**
 * Engine upgrade on a LIVE vault DO. A deploy that moves the engine pin does
 * not recreate any DO: the next wake runs the new engine's `initSchema` over
 * the SQLite the old engine wrote. These tests do that on DO SQLite (a second
 * `DoSqliteStore` over the same storage = the first wake after a deploy):
 * no DDL may run, `schema_version` must not move, and the engine's new reads
 * (`PRAGMA data_version` in the config cache, the newer-schema guard) must
 * work under workerd. Data written by 1a66150 vs this engine is compared
 * byte-for-byte under bun:sqlite in the pin PR (same SCHEMA_VERSION, same DDL).
 */

const stubFor = (v: string) => env.VAULT.get(env.VAULT.idFromName(v));
const master = (sql: SqlStorage) =>
  sql.exec("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").toArray();
const versions = (sql: SqlStorage) => sql.exec("SELECT version FROM schema_version ORDER BY version").toArray();

describe("engine upgrade on an existing vault DO", () => {
  it("a re-boot over existing data runs no DDL, keeps schema_version, and serves the data", async () => {
    const v = freshVault("engup");
    const parent = await createNote(v, { content: "parent", path: "Projects/Old", tags: ["project"] });
    await runInDurableObject<DurableObject, void>(stubFor(v), async (inst: any) => {
      await inst.store.upsertTagRecord("task", {
        fields: { node: { type: "reference", indexed: true }, status: { type: "string", enum: ["open", "done"], indexed: true } },
      });
    });
    const child = await createNote(v, { content: "child [[Projects/Old]]", path: "Tasks/One", tags: ["task"], metadata: { node: "Projects/Old", status: "open" } });

    await runInDurableObject<DurableObject, void>(stubFor(v), async (inst: any) => {
      const sql: SqlStorage = inst.ctx.storage.sql;
      const masterBefore = master(sql);
      const versionsBefore = versions(sql);
      expect(versionsBefore.at(-1)).toEqual({ version: SCHEMA_VERSION });

      // The first wake after a deploy: a new store over the same DO storage.
      const next = new DoSqliteStore(inst.shim, inst.ctx.storage);
      expect(master(sql)).toEqual(masterBefore);
      expect(versions(sql)).toEqual(versionsBefore);

      // The config cache reads PRAGMA data_version on DO SQLite (new in v0.8).
      expect(sql.exec("PRAGMA data_version").toArray()[0]).toHaveProperty("data_version");
      expect(next.getTagHierarchy()).toBeTruthy();
      const found = await next.queryNotes({ tags: ["task"], metadata: { status: { eq: "open" } } } as never);
      expect(found.map((n: { id: string }) => n.id)).toEqual([child.id]);
      expect(next.validateNoteAgainstSchemas({ tags: ["task"], metadata: { status: "nope" } })?.warnings?.[0]?.reason).toBe("enum_mismatch");
    });

    // The live DO (its own store) still answers over REST, and v0.8's rename
    // repair rewrites the reference-field path on DO SQLite.
    const renamed = await op(v, `/api/notes/${parent.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "Projects/New", force: true }),
    });
    expect(renamed.status, await renamed.clone().text()).toBe(200);
    const after = await (await op(v, `/api/notes/${child.id}`)).json() as any;
    expect(after.metadata.node).toBe("Projects/New");
  });

  it("a DO stamped with a newer schema refuses to boot and writes nothing", async () => {
    const v = freshVault("engnewer");
    await createNote(v, { content: "x" });
    await runInDurableObject<DurableObject, void>(stubFor(v), async (inst: any) => {
      const sql: SqlStorage = inst.ctx.storage.sql;
      sql.exec("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)", SCHEMA_VERSION + 1, new Date().toISOString());
      const before = versions(sql);
      const masterBefore = master(sql);
      expect(() => new DoSqliteStore(inst.shim, inst.ctx.storage)).toThrow(NewerSchemaError);
      expect(versions(sql)).toEqual(before);
      expect(master(sql)).toEqual(masterBefore);
      // Leave the DO usable for nothing else in this file: unique name, discarded.
      sql.exec("DELETE FROM schema_version WHERE version = ?", SCHEMA_VERSION + 1);
    });
  });

  // The test above re-boots a DO the CURRENT engine already booted, so it cannot see DDL the current engine runs on
  // every boot. This one compares against what the rollback engine itself writes: if they differ, a deploy migrates
  // existing vaults to something the rollback target may not open.
  it(`a fresh DO has exactly the rollback engine's DDL (${ROLLBACK_ENGINE})`, async () => {
    const v = freshVault("engddl");
    // The same four notes the fixture was generated with: they create the lazy link tables.
    await createNote(v, { content: "x [[Nowhere]]" });
    await createNote(v, { content: "a", path: "A/Same" });
    await createNote(v, { content: "b", path: "B/Same" });
    await createNote(v, { content: "[[Same]]" });
    await runInDurableObject<DurableObject, void>(stubFor(v), async (inst: any) => {
      const sql: SqlStorage = inst.ctx.storage.sql;
      expect(SCHEMA_VERSION).toBe(ROLLBACK_ENGINE_DDL.schema_version);
      expect(versions(sql).at(-1)).toEqual({ version: ROLLBACK_ENGINE_DDL.schema_version });
      // Cloud-owned objects and the platform's own tables are not the engine's.
      const cloudOwned = new Set(["attachment_tickets"]);
      const engine = master(sql).filter((o: any) => !String(o.name).startsWith("_cf_") && !String(o.name).startsWith("sqlite_") && !cloudOwned.has(String(o.name)));
      // T-318-09 (STAGING branch only): core 0.9 adds one column, tags.kind (UPGRADE-0.9.md: additive, no schema
      // number; older engines never read it). Everything else must still equal the rollback engine's DDL exactly.
      expect(engine).toEqual(ROLLBACK_ENGINE_DDL.objects.map(with09TagKind));
    });
  });

  it("the first 0.9 wake over a DO whose tags table has no kind (as the rollback engine wrote it) adds only that column (T-318-09)", async () => {
    const v = freshVault("engddl09");
    // Wake the DO with no notes, so no tag rows hold note_tags' foreign key.
    await runInDurableObject<DurableObject, void>(stubFor(v), async (inst: any) => {
      const sql: SqlStorage = inst.ctx.storage.sql;
      // Put the rollback engine's tags table in place (its fixture DDL, no kind): build it beside, drop the 0.9 one,
      // rename. Renaming INTO "tags" leaves note_tags' foreign key (to "tags") as it was.
      const tags = ROLLBACK_ENGINE_DDL.objects.find((o) => o.type === "table" && o.name === "tags")!.sql!;
      sql.exec(tags.replace(/CREATE TABLE (IF NOT EXISTS )?"?tags"?/, "CREATE TABLE tags_old"));
      sql.exec("DROP TABLE tags");
      sql.exec("ALTER TABLE tags_old RENAME TO tags");
      for (const o of ROLLBACK_ENGINE_DDL.objects.filter((o) => o.type === "index" && o.tbl_name === "tags" && o.sql)) sql.exec(o.sql!);
      const cols = () => sql.exec("PRAGMA table_info(tags)").toArray().map((c: any) => c.name);
      const oldCols = ["name", "description", "fields", "relationships", "parent_names", "created_at", "updated_at"];
      expect(cols()).toEqual(oldCols);
      const others = () => master(sql).filter((o: any) => o.tbl_name !== "tags");
      const othersBefore = others();
      const versionsBefore = versions(sql);
      // The first wake of the 0.9 engine over it: one ALTER, nothing else, schema_version unchanged.
      new DoSqliteStore(inst.shim, inst.ctx.storage);
      expect(cols()).toEqual([...oldCols, "kind"]);
      expect(others()).toEqual(othersBefore);
      expect(versions(sql)).toEqual(versionsBefore);
      // A second wake runs no DDL at all.
      const masterAfter = master(sql);
      new DoSqliteStore(inst.shim, inst.ctx.storage);
      expect(master(sql)).toEqual(masterAfter);
    });
    // The live DO (its own store) works on it: a type with fields, and a note's types.
    await runInDurableObject<DurableObject, void>(stubFor(v), async (inst: any) => {
      await inst.store.upsertTagRecord("task", { fields: { status: { type: "string" } } });
    });
    const n = await createNote(v, { content: "after", tags: ["task", "pinned"] });
    const got = (await (await op(v, `/api/notes/${n.id}`)).json()) as any;
    expect(got.tags.sort()).toEqual(["pinned", "task"]);
    expect(got.types).toEqual(["task"]);
  });
});

/** The rollback engine's object as core 0.9 writes it: the tags table with `kind TEXT` appended, nothing else. */
function with09TagKind(o: { type: string; name: string; tbl_name: string; sql: string | null }) {
  if (o.type !== "table" || o.name !== "tags" || !o.sql) return o;
  const i = o.sql.lastIndexOf("updated_at TEXT");
  return {
    ...o,
    sql:
      o.sql.slice(0, i) +
      "updated_at TEXT,\n  -- T-318 §8a: 'type' (fields, parents) or 'tag' (a flat label); NULL on a\n  -- row made implicitly by tagging, read by the same rule (tag-kind.ts).\n  -- Additive, with no schema number: see ensureTagKinds.\n  kind TEXT" +
      o.sql.slice(i + "updated_at TEXT".length),
  };
}
