import path from "node:path";
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

/**
 * The conformance corpus runs the Identity Worker inside workerd (real D1, real
 * WebCrypto, real jose) via `@cloudflare/vitest-pool-workers`. Migrations are
 * read at config time and handed to the worker as a `TEST_MIGRATIONS` binding;
 * `test/apply-migrations.ts` applies them once per worker (outside isolated
 * storage) so every test sees the schema but its own row writes roll back.
 */
export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, "migrations"));
  return {
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      poolOptions: {
        workers: {
          wrangler: { configPath: "./wrangler.toml" },
          miniflare: {
            // Surfaced to `test/apply-migrations.ts` via `env.TEST_MIGRATIONS`.
            bindings: { TEST_MIGRATIONS: migrations },
          },
        },
      },
    },
  };
});
