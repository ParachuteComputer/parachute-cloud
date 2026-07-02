import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";
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

export default defineWorkersConfig({
  plugins: [jsToTsResolver()],
  resolve: {
    alias: {
      "bun:sqlite": new URL("./test/bun-sqlite-stub.ts", import.meta.url).pathname,
    },
  },
  test: {
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
            VAULT_BASE_DOMAIN: "u.parachute.computer",
            CAP_BYTES: "2000000",
            VAULT_AUTH_TOKEN: "test-operator-token",
            TEST_JWKS: TEST_PUBLIC_JWKS,
          },
        },
      },
    },
  },
});
