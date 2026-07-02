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
 * Not yet routed through here (still no-op-intercepted by the shim, harmless on
 * a single-writer DO but not atomic-on-caught-error):
 *  - core's FREE `transaction(db, fn)` call sites (renameTag / mergeTags /
 *    batchTag / createNotes / boot migrations) — they call the helper with the
 *    shim `db` directly, not `Store.transaction`. Making those DO-atomic + fully
 *    zeroing the interception counter is a ~3-line core follow-up: teach
 *    `transaction(db, fn)` to prefer a native `db.transactionSync` when present.
 *  - the ASYNC batch (`transactionAsync`) — `transactionSync` forbids awaiting,
 *    so the async Store-facade batch can't map onto it (core defers this too).
 */
import { BunSqliteStore } from "@openparachute/core/src/store.js";
import type { HookRegistry } from "@openparachute/core/src/hooks.js";

export class DoSqliteStore extends BunSqliteStore {
  private readonly storage: DurableObjectStorage;

  constructor(db: unknown, storage: DurableObjectStorage, opts?: { hooks?: HookRegistry }) {
    // BunSqliteStore's constructor runs initSchema(db) — the boot migrations use
    // core's FREE transaction helper (shim no-ops their BEGIN); `this.transaction`
    // below is only exercised post-boot, so `storage` being assigned after
    // `super()` is fine.
    super(db as never, opts);
    this.storage = storage;
  }

  /** DO backend of the transaction seam: a real `transactionSync` (commit on
   *  return, rollback on throw), replacing the bun `BEGIN IMMEDIATE … COMMIT`. */
  override transaction<T>(fn: () => T): T {
    return this.storage.transactionSync(fn);
  }
}
