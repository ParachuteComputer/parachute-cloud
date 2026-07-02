import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

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
        wrangler: { configPath: "./wrangler.toml" },
      },
    },
  },
});
