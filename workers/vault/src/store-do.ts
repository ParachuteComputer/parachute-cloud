/**
 * DoSqliteStore — the Durable-Object backend of core's transaction seam
 * (vault#521, design §4).
 *
 * core's atomic blocks route through the seam rather than emitting raw
 * `BEGIN`/`COMMIT` (the one construct DO's `sql.exec` blocks). `Store.transaction`
 * is the object-level entry point (core/src/types.ts): the bun backend runs it
 * as `BEGIN IMMEDIATE … COMMIT`; here we run it as `ctx.storage.transactionSync`,
 * which is a REAL DO transaction — commit on return, rollback on throw — with no
 * raw `BEGIN` reaching the shim.
 *
 * This makes `upsertTagRecord`'s indexed-field reconciliation atomic on DO: the
 * schema row + `ALTER TABLE … ADD COLUMN … GENERATED` + `CREATE INDEX` all
 * commit together, and a mid-block throw (e.g. a cross-tag type mismatch caught
 * inside `declareField`) rolls the whole thing back instead of leaving a schema
 * row that claims an index the engine never built.
 *
 * The other two transaction paths go through the shim (src/shim.ts), not here:
 *  - core's FREE `transaction(db, fn)` call sites (renameTag / mergeTags /
 *    batchTag / createNotes / boot migrations) prefer the shim's
 *    `transactionSync` (vault#523);
 *  - core's ASYNC batch seam (`transactionAsync`: a multi-note POST, MCP
 *    create-note / update-note batches) prefers the shim's `transactionAsync`,
 *    a real `ctx.storage.transaction` (audit L2-05, test/batch-atomic.test.ts).
 */
import { BunSqliteStore } from "@openparachute/core/src/store.js";
import type { HookRegistry } from "@openparachute/core/src/hooks.js";
import type { EmbeddingProvider } from "@openparachute/core/src/embedding/provider.js";
import type { HistoryPolicy } from "@openparachute/core/src/history.js";

export class DoSqliteStore extends BunSqliteStore {
  private readonly storage: DurableObjectStorage;

  constructor(
    db: unknown,
    storage: DurableObjectStorage,
    opts?: { history?: Partial<HistoryPolicy>; hooks?: HookRegistry; embeddingProvider?: EmbeddingProvider; embeddingDisabledReason?: string },
  ) {
    // BunSqliteStore's constructor runs initSchema(db) — the boot migrations use
    // core's FREE transaction helper (shim no-ops their BEGIN); `this.transaction`
    // below is only exercised post-boot, so `storage` being assigned after
    // `super()` is fine. `embeddingProvider` (semantic search MVP, C2) rides the
    // SAME constructor-injection seam core's Store already defines — the DO
    // passes a lazily-resolving proxy (vault-do.ts) so tests can swap the
    // concrete provider on an already-booted DO instance.
    super(db as never, opts);
    this.storage = storage;
  }

  /** DO backend of the transaction seam: a real `transactionSync` (commit on
   *  return, rollback on throw), replacing the bun `BEGIN IMMEDIATE … COMMIT`. */
  override transaction<T>(fn: () => T): T {
    return this.storage.transactionSync(fn);
  }
}
