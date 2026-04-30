/**
 * Drizzle D1 client factory.
 *
 * Workers handlers receive `env.DB` (a `D1Database` from `@cloudflare/workers-types`).
 * `db(env.DB)` wraps it in a Drizzle handle scoped to our schema. Each request
 * gets its own — D1 bindings are cheap and Drizzle handles are pure.
 */

import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema.ts";

export type Db = ReturnType<typeof db>;

export function db(d1: D1Database) {
  return drizzle(d1, { schema });
}

export { schema };
