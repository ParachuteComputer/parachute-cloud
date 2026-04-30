import type { Config } from "drizzle-kit";

/**
 * Drizzle-kit config for D1.
 *
 * `bun run db:generate` reads `src/db/schema.ts` and writes a new SQL
 * migration into `migrations/`. Apply with:
 *   - `bun run db:migrate:local`  → wrangler dev's local SQLite
 *   - `bun run db:migrate:remote` → the production D1 database
 */
export default {
  schema: "./src/db/schema.ts",
  out: "./migrations",
  dialect: "sqlite",
  driver: "d1-http",
} satisfies Config;
