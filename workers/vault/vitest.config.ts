import { defineWorkersProject } from "@cloudflare/vitest-pool-workers/config";
import { configDefaults, defineConfig } from "vitest/config";
import { TEST_PUBLIC_JWKS } from "./test/test-keys.ts";

/**
 * `@openparachute/core` is raw TypeScript whose internal imports use `.js`
 * specifiers (NodeNext style) that point at sibling `.ts` files, and it
 * value-imports `Database` from `bun:sqlite` purely for type positions. Under
 * Vite/esbuild we (1) rewrite any `.js` import that has a `.ts` sibling, and
 * (2) alias `bun:sqlite` to an empty stub (the value-import is erased at
 * transpile since it's type-only, but the alias covers any residue).
 */
function jsToTsResolver() {
  return {
    name: "js-to-ts-resolver",
    enforce: "pre" as const,
    async resolveId(this: { resolve: Function }, source: string, importer: string | undefined, options: unknown) {
      if (!source.endsWith(".js")) return null;
      const candidate = source.slice(0, -3) + ".ts";
      const resolved = await this.resolve(candidate, importer, { ...(options as object), skipSelf: true });
      return resolved ?? null;
    },
  };
}

/**
 * THREE PROJECTS, one `bun x vitest run` (T-318 money switch). The vault DO reads
 * BILLING_MODE from its env, and a DO's env can't vary per test — so the suite
 * runs twice-shaped:
 *   - `vault`           — everything, under BILLING_MODE="paid": the frozen
 *                         floor (402 plan_required) stays exercised exactly as
 *                         before.
 *   - `vault-open-beta` — test/open-beta/**, under BILLING_MODE="open_beta"
 *                         (the deployed default): a stored `frozen: true`
 *                         must not block writes.
 */
function project(name: string, billingMode: "paid" | "open_beta", files: { include?: string[]; exclude?: string[] }) {
  return defineWorkersProject({
    plugins: [jsToTsResolver()],
    resolve: {
      alias: {
        "bun:sqlite": new URL("./test/bun-sqlite-stub.ts", import.meta.url).pathname,
      },
    },
    test: {
      name,
      ...files,
      testTimeout: 300_000,
      hookTimeout: 300_000,
      poolOptions: {
        workers: {
          // Per-test DO snapshot/restore ("isolated storage") doesn't support
          // SQLite-backed DOs in this pool version (it aborts the run). Each test
          // instead uses a UNIQUE vault name → a fresh DO (idFromName), so state
          // never crosses tests without the snapshot machinery.
          isolatedStorage: false,
          wrangler: { configPath: "./wrangler.toml" },
          miniflare: {
            // Conformance-test bindings. TEST_JWKS lets the auth matrix run
            // without a live Identity Worker (auth.ts validates against this
            // static key set); VAULT_AUTH_TOKEN is the operator bearer the
            // shape/R2/caps tests use; CAP_BYTES is deliberately small so the
            // caps 413 is reachable with a modest upload.
            bindings: {
              ENVIRONMENT: "test",
              ISSUER_ORIGIN: "https://id.test.example",
              CONSOLE_PUBLIC_ORIGIN: "https://my.test.example",
              VAULT_BASE_DOMAIN: "u.parachute.computer",
              CAP_BYTES: "2000000",
              VAULT_AUTH_TOKEN: "test-operator-token",
              TEST_JWKS: TEST_PUBLIC_JWKS,
              BILLING_MODE: billingMode,
              // test/row-cost.test.ts: extra vault sizes to meter (e.g. "5000,50000"); empty in CI.
              ROW_METER_SIZES: process.env.ROW_METER_SIZES ?? "",
              ROW_METER_TOP: process.env.ROW_METER_TOP ?? "",
            },
          },
        },
      },
    },
  });
}

export default defineConfig({
  test: {
    projects: [
      project("vault", "paid", { exclude: [...configDefaults.exclude, "test/open-beta/**", "test/history-graft.test.ts"] }),
      project("vault-open-beta", "open_beta", { include: ["test/open-beta/**/*.test.ts"] }),
      // Its own runtime (T-450): every project is one workerd whose vaults stay in memory for the whole run, and the
      // main project already sits near the heap limit. This file makes some fifty vaults; added to that run it ended
      // "JavaScript heap out of memory" in CI. Same bindings as "vault".
      project("vault-history-graft", "paid", { include: ["test/history-graft.test.ts"] }),
    ],
  },
});
