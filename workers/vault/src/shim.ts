/**
 * DatabaseShim — a `bun:sqlite`-`Database`-shaped adapter over a Cloudflare
 * Durable Object `SqlStorage` handle.
 *
 * `@openparachute/core` is dependency-pure: its `Store` implementation never
 * constructs a database, it takes an injected `Database` handle and calls a
 * tiny synchronous surface on it — `prepare(sql) -> { get, all, run }`,
 * `query(sql)` (a `prepare` alias), and `exec(sql)`. DO's `SqlStorage` is also
 * synchronous, so the adapter is mechanical.
 *
 * Two constructs cannot be passed through verbatim and are intercepted here for
 * the Phase-0 spike:
 *
 *  1. Transaction control (`BEGIN`/`COMMIT`/`ROLLBACK`/`SAVEPOINT`/`RELEASE`).
 *     DO's `sql.exec` throws on explicit transaction statements — the object is
 *     itself the transaction boundary. For the spike we no-op them and COUNT
 *     them (+ capture the core call-site) so Phase 1 can replace the ~13
 *     imperative `BEGIN/COMMIT` blocks with a `store.transaction(cb)` that DO
 *     backs with `ctx.storage.transactionSync`.
 *
 *  2. Durability PRAGMAs (`journal_mode`/`synchronous`/`wal_autocheckpoint`).
 *     DO owns durability; these are meaningless. `journal_mode` is READ back by
 *     `applyConnectionPragmas` (it expects a `{ journal_mode: "wal" }` row), so
 *     we synthesize that row; the rest are no-ops.
 *
 * Everything else — including the introspection PRAGMAs `table_info` /
 * `table_xinfo` and `PRAGMA foreign_keys = ON` — is passed straight through to
 * real DO SQLite. Those are the Phase-0 unknowns; we deliberately let them hit
 * the platform so the spike measures real behavior.
 */

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

export interface InterceptRecord {
  kind: "transaction" | "pragma";
  stmt: string;
  /** First `parachute-vault/core` frame in the call stack, if resolvable. */
  caller?: string;
}

// Leading keyword(s) that mean "transaction control" — blocked by DO sql.exec.
const TXN_RE = /^\s*(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i;
// Durability PRAGMAs DO does not honor (it manages the WAL itself).
const NOOP_PRAGMA_RE = /^\s*PRAGMA\s+(journal_mode|synchronous|wal_autocheckpoint)\b/i;
// journal_mode is read back and must yield a plausible row.
const JOURNAL_PRAGMA_RE = /^\s*PRAGMA\s+journal_mode\b/i;

/**
 * DO's `sql.exec` supports multi-statement strings, leading comments, and
 * trigger `BEGIN...END` bodies — but throws "SQL code did not contain a
 * statement" if the final segment (after the last `;`) is comment/whitespace
 * only. Core's `SCHEMA_SQL` ends with a comment block, so peel trailing
 * comments + whitespace before handing the string to DO. (Empty-after-strip
 * ⇒ nothing to run.)
 */
function stripTrailingComments(sql: string): string {
  let s = sql;
  for (;;) {
    const before = s;
    s = s.replace(/\s+$/, "");
    s = s.replace(/--[^\n]*$/, "");
    s = s.replace(/\/\*[\s\S]*?\*\/\s*$/, "");
    if (s === before) return s;
  }
}

function coreCaller(): string | undefined {
  const stack = new Error().stack;
  if (!stack) return undefined;
  for (const line of stack.split("\n")) {
    if (line.includes("parachute-vault/core") || line.includes("@openparachute/core")) {
      return line.trim().replace(/^at\s+/, "");
    }
  }
  return undefined;
}

class StatementShim {
  constructor(
    private readonly sql: SqlStorage,
    private readonly query: string,
    private readonly db: DatabaseShim,
  ) {}

  get(...params: unknown[]): unknown {
    if (JOURNAL_PRAGMA_RE.test(this.query)) return { journal_mode: "wal" };
    const rows = this.sql
      .exec(this.query, ...(params as SqlStorageValue[]))
      .toArray();
    return rows.length > 0 ? rows[0] : null;
  }

  all(...params: unknown[]): unknown[] {
    if (JOURNAL_PRAGMA_RE.test(this.query)) return [{ journal_mode: "wal" }];
    return this.sql.exec(this.query, ...(params as SqlStorageValue[])).toArray();
  }

  run(...params: unknown[]): RunResult {
    if (JOURNAL_PRAGMA_RE.test(this.query)) return { changes: 0, lastInsertRowid: 0 };
    const cursor = this.sql.exec(this.query, ...(params as SqlStorageValue[]));
    // Drain so the statement executes fully and the counters settle. RETURNING
    // statements produce rows we discard here (core reads those via `.get`).
    cursor.toArray();
    return { changes: cursor.rowsWritten, lastInsertRowid: 0 };
  }
}

export class DatabaseShim {
  /** Transaction-control statements no-op'd (the Phase-1 refactor target). */
  readonly txnIntercepts: InterceptRecord[] = [];
  /** Durability PRAGMAs no-op'd. */
  readonly pragmaNoops: InterceptRecord[] = [];

  constructor(private readonly sql: SqlStorage) {}

  prepare(query: string): StatementShim {
    return new StatementShim(this.sql, query, this);
  }

  // bun:sqlite exposes `.query` as a caching `prepare`; core uses it once.
  query(query: string): StatementShim {
    return new StatementShim(this.sql, query, this);
  }

  exec(sql: string): void {
    if (TXN_RE.test(sql)) {
      this.txnIntercepts.push({ kind: "transaction", stmt: sql.trim(), caller: coreCaller() });
      return;
    }
    if (NOOP_PRAGMA_RE.test(sql)) {
      this.pragmaNoops.push({ kind: "pragma", stmt: sql.trim() });
      return;
    }
    // Pass-through: DDL, DML, SCHEMA_SQL (multi-statement), and the
    // introspection / foreign_keys PRAGMAs the spike is here to measure.
    const cleaned = stripTrailingComments(sql);
    if (cleaned === "") return;
    this.sql.exec(cleaned);
  }

  // Some direct-open core paths (backup, auth-status) call `.close()`; the
  // Store boot path does not, but provide a no-op so the surface is complete.
  close(): void {}
}
