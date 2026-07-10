import fs from "node:fs";
import path from "node:path";
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

/**
 * P1.1 added `[assets] directory = "./dist-assets"` to wrangler.toml, and
 * vitest-pool-workers reads that config at pool startup and HARD-ERRORS if the
 * directory is missing. The real bundle is a build artifact (scripts/build-spa.sh,
 * gitignored) that CI's test job never produces — so ensure a minimal stub
 * index.html exists here (this factory runs in Node, before the pool parses
 * wrangler.toml). When the real build IS present (a deploy, or a local build) it
 * is left untouched: the stub only fills the gap so the ASSETS binding + the `/`
 * SPA-serve path have SOMETHING to serve. Real SPA serving is verified on
 * staging, not in-process.
 */
function ensureAssetsDir(): void {
  const dir = path.join(__dirname, "dist-assets");
  const index = path.join(dir, "index.html");
  if (fs.existsSync(index)) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    index,
    '<!doctype html><html><head><meta charset="utf-8"><title>Parachute</title>' +
      '<meta name="parachute-spa-stub" content="test"></head><body><div id="root"></div></body></html>\n',
  );
}
ensureAssetsDir();

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
            // ENVIRONMENT is PINNED here (overrides the wrangler.toml [vars],
            // which say "production" since the top level became the production
            // deploy): the suite depends on the x-parachute-dev-magic-link echo
            // being ON by default, with the production-drops-it case exercised
            // via an explicit env override in auth.test.ts.
            bindings: { TEST_MIGRATIONS: migrations, ENVIRONMENT: "test" },
          },
        },
      },
    },
  };
});
