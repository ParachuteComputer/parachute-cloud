/**
 * In-memory SQLite drizzle handle for unit tests.
 *
 * Loads the latest migration SQL into a fresh `bun:sqlite` database and
 * wraps it with drizzle's `bun-sqlite` driver. The orchestrate / handler
 * paths operate against `Db` (the d1 driver type); the structural shape
 * is identical for our usage, so the test handle is cast to `Db` at the
 * boundary. Catches schema drift between `src/db/schema.ts` and the
 * generated migration in one step.
 */

import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as schema from "../db/schema.ts";
import type { Db } from "../db/client.ts";

const MIGRATIONS_DIR = new URL("../../migrations", import.meta.url).pathname;

export function makeTestDb(): { db: Db; raw: Database } {
  const raw = new Database(":memory:");
  // bun:sqlite ships with FKs *off* by default — D1 enforces them, so
  // turn them on here too. Without this, the cascade-on-delete from
  // `provisioning_secrets → accounts` is silently a no-op in tests, and
  // FK violations that would 4xx in prod pass.
  raw.exec("PRAGMA foreign_keys = ON;");
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    // Drizzle inserts `--> statement-breakpoint` between independent
    // statements so we run each one separately. `Database.exec` would
    // also work but breakpoint-splitting matches what wrangler does.
    for (const stmt of sql.split(/-->\s*statement-breakpoint/)) {
      const trimmed = stmt.trim();
      if (trimmed.length > 0) raw.exec(trimmed);
    }
  }
  const db = drizzle(raw, { schema }) as unknown as Db;
  return { db, raw };
}
