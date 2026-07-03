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
bun run typecheck           # clean (needs "bun" in tsconfig types for bun:sqlite)
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

## Deploy + bundling

Phase 2+ shipped the production DO (REST + MCP + SSE + export) — the spike RPC
methods above are retained so `test/spike.test.ts` stays green. The worker
deploys to the **Unforced Development** CF account in two environments:
**production** is the top-level wrangler.toml config (custom domain
`u.parachute.computer`, `scripts/deploy-prod.sh` at the repo root) and
**staging** is `[env.staging]` (workers.dev only, own R2 + fresh DOs,
`scripts/deploy-staging.sh`). `TRYIT-2026-07-02.md` is the original
live-deploy report.

**How the bundle works.** `wrangler deploy` bundles with its built-in esbuild.
`@openparachute/core` is raw TypeScript that imports sibling files with `.js`
specifiers (NodeNext); **esbuild resolves those to the `.ts` files natively** —
a TypeScript importer that imports `./x.js` when only `./x.ts` exists is rewritten
by esbuild. So core is bundled with **no custom prebuild or plugin**. (The vitest
`jsToTsResolver` in `vitest.config.ts` exists only because Vite lacks that esbuild
behavior; it is a test-only concern, not a deploy one.) The type-only
`bun:sqlite` value-import in core erases at transpile; `wrangler.toml`'s `[alias]`
mirrors the vitest bun:sqlite alias as depth in case that ever changes.

**Regression guard.** `bun run verify:bundle` emits the deploy bundle and asserts
(1) `@openparachute/core` is inlined and (2) there is **zero** residual `bun:`
import in the output. Run it after any core bump or bundler change.

```sh
cd workers/vault
bun run test            # vitest (workerd) — the wire-contract conformance suite
bun run typecheck       # tsc --noEmit
bun run verify:bundle   # emit + assert the deploy bundle is clean
```
