# `@openparachute/vault-do` — Phase 0 spike

Throwaway measurement scaffolding that proves `@openparachute/core` (vault-core)
boots and operates on **Cloudflare Durable Object SQLite** behind a
`Database`-shaped shim, under **real `workerd`** (via
`@cloudflare/vitest-pool-workers`). It empirically settles the four unknowns that
gate the [Vault Cloud serverless design](../../../parachute.computer/design/2026-07-02-vault-cloud-serverless-design.md)
(§4, §6 Phase 0). This is not the production DO — Phase 2 builds that.

## Run it

```sh
cd workers/vault
bun x vitest run            # all 9 tests; ~5s incl. the 100k-note FTS pass
```

The DO is driven directly over RPC from the tests; the `fetch` handler is a
placeholder so `wrangler` has a valid `main`.

Core is consumed via `file:../../../parachute-vault/core`. The measurements below
were taken against parachute-vault **`main` @ `4c60f10`** (vault 0.6.4). Core has
zero npm deps and never constructs a database — `BunSqliteStore` takes an
injected handle, so the `DatabaseShim` over `ctx.storage.sql` is the only seam.

## Results (measured, 2026-07-02)

| Gating unknown | Verdict | Evidence |
|---|---|---|
| **1. Generated columns** (`ALTER TABLE … ADD COLUMN … GENERATED ALWAYS AS (json_extract(…)) VIRTUAL`) | ✅ PASS | column computes from metadata JSON; operator queries route through it + its index |
| **2. `ALTER TABLE` ADD / DROP COLUMN** | ✅ PASS | ADD on indexed-field declare; `DROP COLUMN` on release, verified gone via `table_xinfo` |
| **3. `RETURNING`** | ✅ PASS | all core sites: OC-probe `RETURNING id`, conditional-update `.get`, stale→null→`ConflictError`, `renameTag` `RETURNING note_id` |
| **4. Introspection PRAGMAs** (`table_info` / `table_xinfo`) | ✅ PASS | 11 rows each; `table_xinfo` detects the generated column |

Additional findings:

- **Boot**: `SCHEMA_SQL` v23 + migrations boot clean through the `BunSqliteStore`
  constructor. `schema_version` = 23, 17 tables. **FK cascade enforced**
  (`note_tags` cascade-deleted on note delete). Full CRUD round-trip green.
- **Transaction interception**: 4 statements no-op'd on the boot path
  (2× `BEGIN IMMEDIATE` + 2× `COMMIT`, from `migrateToV14` + `migrateToV18`) —
  the Phase-1 `store.transaction()` refactor targets. DO's `sql.exec` throws on
  explicit transaction control, so these are counted no-ops for the spike.
- **PRAGMA no-ops**: `synchronous`, `wal_autocheckpoint` (DO owns durability);
  `journal_mode` is synthesized to `wal` on read-back.
- **`sql.exec` quirk**: throws *"SQL code did not contain a statement"* on a
  trailing-comment-only / comment-only tail — the shim strips trailing comments
  (`SCHEMA_SQL` ends in one). Multi-statement, trigger `BEGIN…END` bodies, and
  leading comments are all tolerated.
- **FTS5** (external-content; triggers maintain the index):

  | corpus | MATCH+rank | insert | size |
  |---|---|---|---|
  | 10k notes | 1–2 ms | 35 µs/note | 341 B/note |
  | 100k notes | 11–17 ms | 41 µs/note | 351 B/note |

- **`sql.databaseSize`**: real proportional byte accounting (empty schema 180 KB
  → 100k notes 35.3 MB, ~350 B/note) — validates the in-DO caps meter.

**Verdict: all four unknowns green → the Durable-Object design is real.** No
Fly-fallback conversation needed.
