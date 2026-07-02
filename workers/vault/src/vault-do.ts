/**
 * VaultDO — the Phase-0 spike Durable Object.
 *
 * Boots `@openparachute/core`'s `BunSqliteStore` against DO SQLite through the
 * `DatabaseShim`, then exposes RPC methods that exercise the boot path and the
 * four gating unknowns (generated columns, ALTER ADD/DROP COLUMN, RETURNING,
 * introspection PRAGMAs), plus FTS5 MATCH/rank timing and `databaseSize`
 * accounting. This is throwaway measurement scaffolding, not the eventual
 * production DO.
 */
import { DurableObject } from "cloudflare:workers";
import { BunSqliteStore } from "@openparachute/core/src/store.js";
import { SCHEMA_VERSION } from "@openparachute/core/src/schema.js";
import { DatabaseShim } from "./shim.js";

function errText(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

type StepResult = { step: string; ok: boolean; detail?: unknown; error?: string };

export class VaultDO extends DurableObject {
  private shim: DatabaseShim;
  private store!: BunSqliteStore;
  private bootError: string | null = null;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    this.shim = new DatabaseShim(ctx.storage.sql);
    try {
      // BunSqliteStore's constructor runs initSchema(db) synchronously — this
      // IS the boot test (SCHEMA_SQL v23 + all migrateToVN steps).
      this.store = new BunSqliteStore(this.shim as never);
    } catch (e) {
      this.bootError = errText(e);
    }
  }

  private raw() {
    return this.ctx.storage.sql;
  }

  // --- Probe: what does DO's sql.exec tolerate? (multi-statement, comments) ---
  async sqlProbe() {
    const sql = this.raw();
    const out: Record<string, string> = {};
    const tryExec = (label: string, q: string) => {
      try {
        sql.exec(q);
        out[label] = "ok";
      } catch (e) {
        out[label] = errText(e);
      }
    };
    tryExec("single", "CREATE TABLE p_single (x)");
    tryExec("single_trailing_semicolon", "CREATE TABLE p_semi (x);");
    tryExec("multi_two", "CREATE TABLE p_a (x); CREATE TABLE p_b (y)");
    tryExec("leading_comment", "-- lead\nCREATE TABLE p_d (x)");
    tryExec("trailing_comment", "CREATE TABLE p_e (x);\n-- trail\n");
    tryExec("comment_only", "-- just a comment\n");
    tryExec(
      "trigger_then_stmt",
      "CREATE TABLE p_f (x);\n" +
        "CREATE TRIGGER p_trg AFTER INSERT ON p_f BEGIN\n" +
        "  UPDATE p_f SET x = new.x;\n" +
        "END;\n" +
        "CREATE INDEX p_idx ON p_f(x);",
    );
    return out;
  }

  // --- Unknown-agnostic: report boot outcome + intercept ledger ---
  async boot() {
    return {
      ok: this.bootError === null,
      error: this.bootError,
      schemaVersion: SCHEMA_VERSION,
      recordedSchemaVersion: this.bootError
        ? null
        : (this.raw().exec("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1").toArray()[0] ?? null),
      txnIntercepts: this.shim.txnIntercepts,
      txnInterceptCount: this.shim.txnIntercepts.length,
      pragmaNoops: this.shim.pragmaNoops.map((p) => p.stmt),
      tableCount: this.bootError
        ? null
        : this.raw().exec("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").one().n,
    };
  }

  // --- Unknown #4: introspection PRAGMAs (table_info / table_xinfo) ---
  async introspect() {
    const out: Record<string, unknown> = {};
    try {
      const tableInfo = this.raw().exec("PRAGMA table_info(notes)").toArray();
      out.table_info_rows = tableInfo.length;
      out.table_info_columns = tableInfo.map((r) => (r as { name: string }).name);
      out.table_info_ok = tableInfo.length > 0;
    } catch (e) {
      out.table_info_ok = false;
      out.table_info_error = errText(e);
    }
    try {
      const xinfo = this.raw().exec("PRAGMA table_xinfo(notes)").toArray();
      out.table_xinfo_rows = xinfo.length;
      out.table_xinfo_ok = xinfo.length > 0;
    } catch (e) {
      out.table_xinfo_ok = false;
      out.table_xinfo_error = errText(e);
    }
    // foreign_keys behavior (passed through — not in the no-op set)
    try {
      const fk = this.raw().exec("PRAGMA foreign_keys").toArray();
      out.foreign_keys_read = fk[0] ?? null;
    } catch (e) {
      out.foreign_keys_read_error = errText(e);
    }
    try {
      this.raw().exec("PRAGMA foreign_keys = ON");
      out.foreign_keys_set_ok = true;
    } catch (e) {
      out.foreign_keys_set_ok = false;
      out.foreign_keys_set_error = errText(e);
    }
    return out;
  }

  // --- CRUD round-trip through core, incl. FK cascade on delete ---
  async crud() {
    const steps: StepResult[] = [];
    try {
      const created = await this.store.createNote("hello [[world]] #greeting", {
        path: "greetings/hello",
        tags: ["greeting"],
        metadata: { mood: "warm" },
      });
      steps.push({ step: "create", ok: !!created.id, detail: { id: created.id, tags: created.tags } });

      const read = await this.store.getNote(created.id);
      steps.push({ step: "read", ok: read?.content === "hello [[world]] #greeting", detail: { tags: read?.tags } });

      const updated = await this.store.updateNote(created.id, { content: "goodbye", metadata: { mood: "cool" } });
      steps.push({ step: "update", ok: updated.content === "goodbye" && (updated.metadata as { mood?: string })?.mood === "cool" });

      // note_tags has ON DELETE CASCADE → after delete the join row should be gone iff FK cascade is enforced.
      const tagRowsBefore = this.raw().exec("SELECT COUNT(*) AS n FROM note_tags WHERE note_id = ?", created.id).one().n;
      await this.store.deleteNote(created.id);
      const gone = (await this.store.getNote(created.id)) === null;
      const tagRowsAfter = this.raw().exec("SELECT COUNT(*) AS n FROM note_tags WHERE note_id = ?", created.id).one().n;
      steps.push({
        step: "delete+cascade",
        ok: gone,
        detail: { gone, tagRowsBefore, tagRowsAfter, fkCascadeEnforced: tagRowsAfter === 0 },
      });
    } catch (e) {
      steps.push({ step: "threw", ok: false, error: errText(e) });
    }
    return { ok: steps.every((s) => s.ok), steps };
  }

  // --- Unknowns #1 (generated columns), #2 (ADD/DROP COLUMN), #4 (table_xinfo) ---
  async indexedField() {
    const steps: StepResult[] = [];
    const colPresent = () =>
      (this.raw().exec("PRAGMA table_xinfo(notes)").toArray() as { name: string }[]).some((r) => r.name === "meta_priority");
    try {
      // Declares field via the store chokepoint: BEGIN IMMEDIATE (intercepted)
      // + declareField → table_xinfo probe + ALTER TABLE ADD COLUMN ... GENERATED
      // ALWAYS AS (json_extract(...)) VIRTUAL + CREATE INDEX.
      await this.store.upsertTagRecord("meeting", {
        fields: { priority: { type: "integer", indexed: true } },
      });
      steps.push({ step: "declare-indexed-field", ok: colPresent(), detail: { generatedColumnCreated: colPresent() } });

      // A note whose metadata populates the generated column.
      const n = await this.store.createNote("standup", { tags: ["meeting"], metadata: { priority: 5 } });
      await this.store.createNote("retro", { tags: ["meeting"], metadata: { priority: 1 } });

      // Operator query routes through the generated column + its index.
      const hi = await this.store.queryNotes({ tags: ["meeting"], metadata: { priority: { gte: 3 } } });
      steps.push({
        step: "operator-query-via-generated-column",
        ok: hi.length === 1 && hi[0]?.id === n.id,
        detail: { matched: hi.length },
      });

      // Confirm the generated column actually computes from metadata JSON.
      const rawVal = this.raw().exec("SELECT meta_priority FROM notes WHERE id = ?", n.id).one();
      steps.push({ step: "generated-column-computes", ok: (rawVal as { meta_priority: number }).meta_priority === 5, detail: rawVal });

      // Release → DROP INDEX + ALTER TABLE DROP COLUMN (unknown #2, drop side).
      await this.store.upsertTagRecord("meeting", { fields: {} });
      steps.push({ step: "drop-column-on-release", ok: !colPresent(), detail: { columnStillPresent: colPresent() } });
    } catch (e) {
      steps.push({ step: "threw", ok: false, error: errText(e) });
    }
    return { ok: steps.every((s) => s.ok), steps };
  }

  // --- Unknown #3: RETURNING (optimistic-concurrency update paths) ---
  async returningOC() {
    const steps: StepResult[] = [];
    try {
      const n = await this.store.createNote("v1");
      const stamp = n.updatedAt ?? n.createdAt;

      // sets.length===0 + if_updated_at → the no-op RETURNING id probe (notes.ts:563).
      await this.store.updateNote(n.id, { skipUpdatedAt: true, if_updated_at: stamp });
      steps.push({ step: "noop-oc-probe(RETURNING id)", ok: true });

      // Conditional update → `${sql} RETURNING id` .get() (notes.ts:595), matched.
      const okUpd = await this.store.updateNote(n.id, { content: "v2", if_updated_at: stamp });
      steps.push({ step: "conditional-update-matched(RETURNING id)", ok: okUpd.content === "v2" });

      // Stale precondition → RETURNING id yields null → ConflictError.
      let conflict = false;
      let conflictText = "";
      try {
        await this.store.updateNote(n.id, { content: "v3", if_updated_at: "2000-01-01T00:00:00.000Z" });
      } catch (e) {
        conflict = true;
        conflictText = errText(e);
      }
      steps.push({ step: "stale-oc-conflict-detected", ok: conflict, detail: conflictText });
    } catch (e) {
      steps.push({ step: "threw", ok: false, error: errText(e) });
    }
    return { ok: steps.every((s) => s.ok), steps };
  }

  // --- Unknown #3 (second RETURNING site): renameTag repoint (notes.ts:1461) ---
  async renameTagReturning() {
    const steps: StepResult[] = [];
    try {
      const n = await this.store.createNote("tagged", { tags: ["projectx"] });
      const result = await this.store.renameTag("projectx", "projecty");
      steps.push({ step: "renameTag(RETURNING note_id)", ok: "renamed" in result, detail: result });

      const asY = await this.store.queryNotes({ tags: ["projecty"] });
      const asX = await this.store.queryNotes({ tags: ["projectx"] });
      steps.push({
        step: "repointed-note-tags",
        ok: asY.length === 1 && asY[0]?.id === n.id && asX.length === 0,
        detail: { asY: asY.length, asX: asX.length },
      });
    } catch (e) {
      steps.push({ step: "threw", ok: false, error: errText(e) });
    }
    return { ok: steps.every((s) => s.ok), steps };
  }

  // --- FTS5 external-content MATCH/rank timing + databaseSize accounting ---
  async fts(count: number) {
    const sql = this.raw();
    const vocab = [
      "vault", "note", "parachute", "durable", "object", "sqlite", "cloud",
      "query", "search", "index", "token", "graph", "tag", "link", "meeting", "project",
    ];
    const now = new Date().toISOString();
    const sizeBefore = sql.databaseSize;

    // Raw inserts (the notes_fts insert trigger maintains the FTS index) — the
    // corpus build deliberately bypasses store overhead (wikilink sync, hooks,
    // read-back) to isolate FTS write + query cost.
    const stmt = this.shim.prepare(
      "INSERT INTO notes (id, content, path, metadata, created_at, updated_at, extension) VALUES (?,?,?,?,?,?, 'md')",
    );
    const insertStart = Date.now();
    for (let i = 0; i < count; i++) {
      const words: string[] = [];
      for (let w = 0; w < 8; w++) words.push(vocab[(i * 7 + w) % vocab.length]!);
      stmt.run(`fts-${i}`, `synthetic entry ${i} ${words.join(" ")}`, null, "{}", now, now);
    }
    const insertMs = Date.now() - insertStart;
    const sizeAfter = sql.databaseSize;

    const time = async (q: string) => {
      const t = Date.now();
      const rows = await this.store.searchNotes(q, { limit: 20 });
      return { q, ms: Date.now() - t, hits: rows.length };
    };

    // Warm once, then measure (parse/plan caching).
    await this.store.searchNotes("parachute", { limit: 20 });
    const searches = [await time("parachute"), await time("meeting"), await time("parachute cloud"), await time("nonexistentzzz")];

    const total = sql.exec("SELECT COUNT(*) AS n FROM notes").one().n as number;
    const ftsTotal = sql.exec("SELECT COUNT(*) AS n FROM notes_fts").one().n as number;

    return {
      count,
      inserted: total,
      ftsRows: ftsTotal,
      insertMs,
      insertPerNoteMicros: Math.round((insertMs / count) * 1000),
      searches,
      databaseSize: { before: sizeBefore, after: sizeAfter, delta: sizeAfter - sizeBefore, bytesPerNote: Math.round((sizeAfter - sizeBefore) / count) },
      txnInterceptCount: this.shim.txnIntercepts.length,
    };
  }
}
