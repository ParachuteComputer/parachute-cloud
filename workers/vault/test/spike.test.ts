import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

/**
 * Phase-0 spike: prove @openparachute/core boots + operates on Durable Object
 * SQLite behind the DatabaseShim, and settle the four gating unknowns
 * empirically. Each test drives a fresh DO instance over RPC and logs its
 * result payload so the run output carries the measurements for the report.
 */

function log(label: string, payload: unknown) {
  // eslint-disable-next-line no-console
  console.log(`\n[SPIKE:${label}] ` + JSON.stringify(payload, null, 2));
}

// This workerd (compat 2025-07-12) predates DurableObjectNamespace.getByName;
// use the universally-supported idFromName + get.
function stubFor(name: string) {
  return env.VAULT.get(env.VAULT.idFromName(name));
}

describe("vault-core on DO SQLite", () => {
  it("PROBE — DO sql.exec statement/comment tolerance", async () => {
    const stub = stubFor("sqlprobe");
    const r = await stub.sqlProbe();
    log("sqlProbe", r);
  });

  it("boots SCHEMA v23 + all migrations (BEGIN/COMMIT intercepted)", async () => {
    const stub = stubFor("boot");
    const r = await stub.boot();
    log("boot", r);
    expect(r.ok).toBe(true);
    expect(r.error).toBeNull();
    expect(r.schemaVersion).toBe(23);
    expect(Number(r.tableCount)).toBeGreaterThan(5);
  });

  it("UNKNOWN#4 — introspection PRAGMAs table_info / table_xinfo pass through", async () => {
    const stub = stubFor("introspect");
    const r = await stub.introspect();
    log("introspect", r);
    expect(r.table_info_ok).toBe(true);
    expect(r.table_xinfo_ok).toBe(true);
    // xinfo must at least match info (it additionally exposes generated/hidden cols)
    expect(Number(r.table_xinfo_rows)).toBeGreaterThanOrEqual(Number(r.table_info_rows));
  });

  it("CRUD round-trip through core (create/read/update/delete + FK cascade)", async () => {
    const stub = stubFor("crud");
    const r = await stub.crud();
    log("crud", r);
    expect(r.ok).toBe(true);
  });

  it("UNKNOWN#1+#2 — generated column ADD + operator query + DROP COLUMN on release", async () => {
    const stub = stubFor("indexed");
    const r = await stub.indexedField();
    log("indexedField", r);
    expect(r.ok).toBe(true);
  });

  it("UNKNOWN#3 — RETURNING on optimistic-concurrency update paths", async () => {
    const stub = stubFor("returning-oc");
    const r = await stub.returningOC();
    log("returningOC", r);
    expect(r.ok).toBe(true);
  });

  it("UNKNOWN#3 — RETURNING on renameTag note_tags repoint", async () => {
    const stub = stubFor("returning-rename");
    const r = await stub.renameTagReturning();
    log("renameTagReturning", r);
    expect(r.ok).toBe(true);
  });

  it("FTS5 MATCH/rank timing + databaseSize @ 10k notes", async () => {
    const stub = stubFor("fts-10k");
    const r = await stub.fts(10_000);
    log("fts-10k", r);
    expect(r.inserted).toBe(10_000);
    // MATCH+rank must return hits (a thrown/failed query returns [] in core)
    expect(r.searches[0]!.hits).toBeGreaterThan(0);
    expect(r.databaseSize.after).toBeGreaterThan(r.databaseSize.before);
  });

  it("FTS5 MATCH/rank timing + databaseSize @ 100k notes", async () => {
    const stub = stubFor("fts-100k");
    const r = await stub.fts(100_000);
    log("fts-100k", r);
    expect(r.inserted).toBe(100_000);
    expect(r.searches[0]!.hits).toBeGreaterThan(0);
  });
});
