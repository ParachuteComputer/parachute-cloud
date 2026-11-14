/**
 * What a create, a wake and a tagged query cost in Durable Object rows (T-412).
 *
 * Rows read and written are what Cloudflare bills a SQLite Durable Object for, and the free plan caps them per day
 * (5 M read, 100 k written). The Taste Arcade test (11-08) ran out of reads on a 240-note vault: each create looked up
 * its path with `path = ? COLLATE NOCASE` against a case-sensitive index (a scan of every note), and each wake rebuilt
 * a path index over every note (v5) only for v18 to drop it again.
 *
 * Counted with workerd's own per-cursor `rowsRead` / `rowsWritten` (the billed numbers), by putting a counting proxy
 * in front of the vault DO's `SqlStorage`. A "wake" is what the DO constructor does on a vault that already exists:
 * a new shim and a new store (initSchema) on the same storage, then the once-per-load history maintenance.
 *
 * The vault is synthetic and made up: 200 `taste-card` notes and `reaction` notes up to the size, shaped like Arcade's
 * (player and at indexed, card a reference), seeded with SQL so a 50,000-note vault seeds in seconds.
 *
 * CI meters 240 and 2,000 notes and holds the ceilings at the end (each fails on the engine before T-412). `ROW_METER_SIZES=5000,50000 bun x vitest run
 * test/row-cost.test.ts` meters more and prints the table.
 */
import { SELF, env, runInDurableObject } from "cloudflare:test";
import type { DurableObject } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { base, freshVault, op } from "./helpers.ts";
import { DatabaseShim } from "../src/shim.js";
import { DoSqliteStore } from "../src/store-do.js";

const json = (body: unknown) => ({ headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

interface Meter {
  sql: SqlStorage;
  reset(): void;
  totals(): { read: number; written: number };
  /** Rows read per distinct statement, most first. */
  top(k: number): { read: number; n: number; sql: string }[];
}

/** A SqlStorage that remembers every cursor it hands out, so their billed counters can be summed. */
function meter(sql: SqlStorage): Meter {
  let cursors: SqlStorageCursor<Record<string, SqlStorageValue>>[] = [];
  let queries: string[] = [];
  const proxy = new Proxy(sql, {
    get(target, key) {
      if (key === "exec") {
        return (query: string, ...params: SqlStorageValue[]) => {
          const c = target.exec(query, ...params);
          cursors.push(c);
          queries.push(query);
          return c;
        };
      }
      const v = (target as any)[key];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return {
    sql: proxy,
    reset: () => {
      cursors = [];
      queries = [];
    },
    top: (k: number) => {
      const by = new Map<string, { read: number; n: number }>();
      cursors.forEach((c, i) => {
        const q = queries[i]!.replace(/\s+/g, " ").slice(0, 160);
        const e = by.get(q) ?? { read: 0, n: 0 };
        e.read += c.rowsRead;
        e.n++;
        by.set(q, e);
      });
      return [...by.entries()].map(([sql, e]) => ({ sql, ...e })).sort((a, b) => b.read - a.read).slice(0, k);
    },
    totals: () => {
      let read = 0;
      let written = 0;
      for (const c of cursors) {
        read += c.rowsRead;
        written += c.rowsWritten;
      }
      return { read, written };
    },
  };
}

async function inDo<T>(vault: string, fn: (inst: any, state: DurableObjectState) => Promise<T> | T): Promise<T> {
  return runInDurableObject<DurableObject, T>(env.VAULT.get(env.VAULT.idFromName(vault)), fn as any);
}

/** Swap the live vault DO's SqlStorage for a metered one; every later request goes through it. */
async function attachMeter(vault: string): Promise<void> {
  await inDo(vault, (inst: any) => {
    // The test pool's 2 MB storage cap is for the caps tests; a 50,000-note vault is bigger than that.
    inst.env = { ...inst.env, CAP_BYTES: "1000000000" };
    const m = meter(inst.shim.sql);
    inst.shim.sql = m.sql;
    inst.__meter = m;
  });
}
async function metered<T>(vault: string, fn: () => Promise<T>): Promise<{ result: T; read: number; written: number }> {
  await inDo(vault, (inst: any) => inst.__meter.reset());
  const result = await fn();
  const t = await inDo(vault, (inst: any) => inst.__meter.totals());
  return { result, ...t };
}

const PLAYERS = 50;
const CARDS = 200;

/** Make the two Arcade types, then seed `size` notes by SQL (cards first, reactions for the rest). */
async function seed(vault: string, size: number): Promise<void> {
  // First request materialises the vault (and its welcome notes); clear them so the size is exact.
  for (const [tag, fields] of [
    ["taste-card", { card_id: { type: "string", indexed: true }, data: { type: "object" } }],
    ["reaction", {
      player: { type: "string", indexed: true },
      at: { type: "date", indexed: true },
      card: { type: "reference", target_tags: ["taste-card"] },
      rid: { type: "string" },
      data: { type: "object" },
    }],
  ] as const) {
    const r = await op(vault, `/api/tags/${tag}`, { method: "PUT", ...json({ fields }) });
    expect(r.status, await r.clone().text()).toBeLessThan(300);
  }
  // One real reaction, so the seeded link rows copy exactly what the engine writes for a card reference.
  const card0 = await op(vault, "/api/notes", { method: "POST", ...json({ path: "cards/c0", content: "made-up card 0", tags: ["taste-card"], metadata: { card_id: "c0", data: { n: 0 } } }) });
  expect(card0.status).toBe(201);
  const probe = await op(vault, "/api/notes", { method: "POST", ...json({ path: "reactions/probe/r0", content: "made up", tags: ["reaction"], metadata: { player: "probe", at: "2026-11-08T00:00:00.000Z", card: "cards/c0", rid: "r0", data: { v: 1 } } }) });
  expect(probe.status, await probe.clone().text()).toBe(201);
  await inDo(vault, (_inst: any, state: DurableObjectState) => {
    const sql = state.storage.sql;
    const link = sql.exec("SELECT relationship, metadata FROM links WHERE source_id = (SELECT id FROM notes WHERE path = 'reactions/probe/r0')").toArray()[0] as { relationship: string; metadata: string } | undefined;
    // Leave only the two types' notes: drop the welcome notes and the two probes, then seed.
    sql.exec("DELETE FROM notes");
    const now = Date.parse("2026-11-08T00:00:00.000Z");
    const cards = Math.min(CARDS, Math.floor(size / 2));
    sql.exec(
      `WITH RECURSIVE k(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM k WHERE i + 1 < ?)
       INSERT INTO notes (id, content, path, metadata, created_at, updated_at, updated_at_ms, extension)
       SELECT printf('card%08d', i), 'made-up card ' || i, 'cards/c' || i,
              json_object('card_id', 'c' || i, 'data', json_object('n', i)),
              '2026-11-08T00:00:00.000Z', '2026-11-08T00:00:00.000Z', ${now}, 'md' FROM k`,
      cards,
    );
    sql.exec("INSERT INTO note_tags (note_id, tag_name) SELECT id, 'taste-card' FROM notes WHERE path LIKE 'cards/%'");
    const reactions = size - cards;
    if (reactions > 0) {
      sql.exec(
        `WITH RECURSIVE k(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM k WHERE i + 1 < ?)
         INSERT INTO notes (id, content, path, metadata, created_at, updated_at, updated_at_ms, extension)
         SELECT printf('reac%08d', i), 'made up ' || i, printf('reactions/p%d/r%d', i % ${PLAYERS}, i),
                json_object('player', printf('p%d', i % ${PLAYERS}), 'at', '2026-11-08T00:00:00.000Z', 'card', printf('cards/c%d', i % ${cards}), 'rid', 'r' || i, 'data', json_object('v', i)),
                '2026-11-08T00:00:00.000Z', '2026-11-08T00:00:00.000Z', ${now} + i, 'md' FROM k`,
        reactions,
      );
      sql.exec("INSERT INTO note_tags (note_id, tag_name) SELECT id, 'reaction' FROM notes WHERE path LIKE 'reactions/%'");
      if (link) {
        sql.exec(
          `INSERT INTO links (source_id, target_id, relationship, metadata, created_at)
           SELECT n.id, printf('card%08d', CAST(substr(json_extract(n.metadata, '$.card'), 8) AS INTEGER)), ?, ?, n.created_at
           FROM notes n WHERE n.path LIKE 'reactions/%'`,
          link.relationship, link.metadata,
        );
      }
    }
    const count = (sql.exec("SELECT COUNT(*) AS c FROM notes").toArray()[0] as { c: number }).c;
    if (count !== size) throw new Error(`seeded ${count}, wanted ${size}`);
  });
}

interface Row {
  size: number;
  createRead: number;
  createWritten: number;
  createRefRead: number;
  createRefWritten: number;
  arcadeRead: number;
  arcadeWritten: number;
  wakeRead: number;
  wakeWritten: number;
  upgradeRead: number;
  upgradeWritten: number;
  maintRead: number;
  maintWritten: number;
  queryTagFieldRead: number;
  queryTagFieldCount: number;
  deleteRead: number;
  deleteWritten: number;
}

async function measure(size: number): Promise<Row> {
  const vault = freshVault(`rowcost${size}`);
  await seed(vault, size);
  await attachMeter(vault);
  let n = 0;
  const create = async (withCard: boolean, ifExists = false) => {
    n++;
    const player = `p${n % PLAYERS}`;
    const metadata: Record<string, unknown> = { player, at: `2026-11-09T00:00:0${n % 10}.000Z`, rid: `new${n}`, data: { v: n } };
    if (withCard) metadata.card = `cards/c${n % 7}`;
    const r = await op(vault, "/api/notes", { method: "POST", ...json({ path: `reactions/${player}/new${n}`, content: "made up", tags: ["reaction"], metadata, ...(ifExists ? { if_exists: "ignore" } : {}) }) });
    expect(r.status, await r.clone().text()).toBe(201);
    return ((await r.json()) as any).id as string;
  };
  // One create first, so per-process caches (tag schemas, prepared shapes) are warm as they are in a live DO.
  await create(false);
  const avg = async (k: number, fn: () => Promise<unknown>) => {
    let read = 0;
    let written = 0;
    for (let i = 0; i < k; i++) {
      const m = await metered(vault, fn);
      read += m.read;
      written += m.written;
    }
    return { read: Math.round(read / k), written: Math.round(written / k) };
  };
  const plain = await avg(3, () => create(false));
  const withRef = await avg(3, () => create(true));
  const arcade = await avg(3, () => create(true, true));
  if ((env as any).ROW_METER_TOP) {
    const t = await inDo(vault, (inst: any) => inst.__meter.top(8));
    console.log(`[row-cost] ${size}: top statements of one Arcade-shaped create\n` + t.map((x: any) => `${x.read}\t${x.n}x\t${x.sql}`).join("\n"));
  }
  const q = await metered(vault, async () => {
    const r = await op(vault, "/api/notes?tag=reaction&meta%5Bplayer%5D%5Beq%5D=p7&limit=5000&include_content=false");
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    return Array.isArray(body) ? body.length : -1;
  });
  const victim = await create(false);
  const del = await metered(vault, async () => {
    const r = await op(vault, `/api/notes/${victim}`, { method: "DELETE" });
    expect(r.status).toBe(200);
  });
  // The first wake after deploying this engine: the vault as the engine before it left it (no case-insensitive path
  // index), so this wake runs the migrations once and builds the index.
  const upgrade = await inDo(vault, (_inst: any, state: DurableObjectState) => {
    const raw = state.storage.sql;
    raw.exec("DROP INDEX IF EXISTS idx_notes_path_nocase");
    const m = meter(raw);
    new DoSqliteStore(new DatabaseShim(m.sql, state.storage), state.storage);
    return m.totals();
  });
  // A wake: what the constructor and the first request's ensureState do on this existing vault.
  const wake = await inDo(vault, (_inst: any, state: DurableObjectState) => {
    const m = meter(state.storage.sql);
    const shim = new DatabaseShim(m.sql, state.storage);
    const store = new DoSqliteStore(shim, state.storage);
    const boot = m.totals();
    m.reset();
    store.sweepDeletedHistory();
    store.compactHistory();
    const maint = m.totals();
    return { boot, maint };
  });
  return {
    size,
    createRead: plain.read,
    createWritten: plain.written,
    createRefRead: withRef.read,
    createRefWritten: withRef.written,
    arcadeRead: arcade.read,
    arcadeWritten: arcade.written,
    wakeRead: wake.boot.read,
    wakeWritten: wake.boot.written,
    upgradeRead: upgrade.read,
    upgradeWritten: upgrade.written,
    maintRead: wake.maint.read,
    maintWritten: wake.maint.written,
    queryTagFieldRead: q.read,
    queryTagFieldCount: q.result,
    deleteRead: del.read,
    deleteWritten: del.written,
  };
}

function table(rows: Row[]): string {
  const head = "| notes | create read | create written | create+ref read | create+ref written | Arcade create (ref, if_exists) read | written | delete read | delete written | wake read | wake written | wake maint read | first wake after upgrade read | written | tag+field query read (hits) |";
  const sep = "|" + "---|".repeat(15);
  const lines = rows.map((r) =>
    `| ${r.size} | ${r.createRead} | ${r.createWritten} | ${r.createRefRead} | ${r.createRefWritten} | ${r.arcadeRead} | ${r.arcadeWritten} | ${r.deleteRead} | ${r.deleteWritten} | ${r.wakeRead} | ${r.wakeWritten} | ${r.maintRead} | ${r.upgradeRead} | ${r.upgradeWritten} | ${r.queryTagFieldRead} (${r.queryTagFieldCount}) |`,
  );
  return [head, sep, ...lines].join("\n");
}

describe("rows a create, a wake and a tagged query cost (T-412)", () => {
  const extra = String((env as any).ROW_METER_SIZES ?? "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);

  it("meters 240 and 2,000 notes (and ROW_METER_SIZES)", async () => {
    const rows: Row[] = [];
    for (const size of [240, 2000, ...extra]) rows.push(await measure(size));
    console.log(`[row-cost]\n${table(rows)}`);
    const [small, large] = rows as [Row, Row];
    // A create costs the same at 2,000 notes as at 240: no statement reads the vault. (Unfixed core: 8,137 rows
    // for the Arcade-shaped create at 2,000, four `path = ? COLLATE NOCASE` scans.)
    for (const r of [small, large]) {
      expect(r.createRead, "create").toBeLessThan(400);
      expect(r.createRefRead, "create with a reference").toBeLessThan(400);
      expect(r.arcadeRead, "create with a reference and if_exists").toBeLessThan(400);
    }
    expect(large.arcadeRead - small.arcadeRead, "a create's reads grow with the vault").toBeLessThan(20);
    // A wake on a current vault writes nothing and reads the same at any size. (Unfixed: 2,012 rows written,
    // 18,880 read, at 2,000 notes.)
    expect(small.wakeWritten, "wake writes").toBe(0);
    expect(large.wakeWritten, "wake writes").toBe(0);
    // 0.9.3's fast path also checks the search index's `fields` column and insert trigger in sqlite_master (core
    // schema.ts unnumberedStepsDone): a fixed ~150 rows more, the same at any size (T-456 pin bump: 639 at both 240
    // and 2,000 notes).
    expect(large.wakeRead, "wake reads").toBeLessThan(700);
    expect(large.wakeRead - small.wakeRead, "a wake's reads grow with the vault").toBeLessThan(20);
    // A tag filter beside an indexed equality reads per hit, not per note under the tag. (Unfixed: 2,114 rows
    // for 37 hits among 1,800 tagged notes.)
    expect(large.queryTagFieldRead, "tag + indexed field").toBeLessThan(30 * large.queryTagFieldCount + 100);
  });
});
