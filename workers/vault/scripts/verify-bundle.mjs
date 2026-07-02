#!/usr/bin/env bun
/**
 * verify:bundle — emit the deploy bundle and assert it is clean.
 *
 * `wrangler deploy` uses esbuild, which natively rewrites `@openparachute/core`'s
 * `.js` NodeNext specifiers to their `.ts` siblings (see wrangler.toml + README).
 * This guard fails loudly if that ever stops working: it emits the bundle and
 * asserts (1) core is actually inlined, and (2) there is ZERO residual `bun:`
 * import (a real `bun:sqlite` reference would crash the worker at runtime — only
 * a comment mentioning it is allowed).
 *
 * `--dry-run` hits no Cloudflare API, so this needs no account or network.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const outDir = join(root, ".wrangler", "verify-bundle");

rmSync(outDir, { recursive: true, force: true });
execFileSync("bunx", ["wrangler", "deploy", "--dry-run", "--outdir", outDir], {
  cwd: root,
  stdio: "inherit",
});

const bundle = readFileSync(join(outDir, "index.js"), "utf8");
const failures = [];

// (1) Core must be inlined — a handful of symbols only core defines.
for (const symbol of ["generateMcpTools", "notes_fts", "exportVault"]) {
  if (!bundle.includes(symbol)) failures.push(`core symbol \`${symbol}\` missing — core not inlined?`);
}

// (2) No real `bun:` import survived. Strip line comments first so the shim's
// explanatory `// bun:sqlite exposes .query ...` comment doesn't false-positive.
const codeOnly = bundle.replace(/\/\/[^\n]*/g, "");
const bunImport = /(?:import|require)\s*(?:\(|[^;\n]*from)\s*["']bun:/.exec(codeOnly);
if (bunImport) failures.push(`residual bun: import in bundle: ${bunImport[0]}`);

if (failures.length > 0) {
  console.error("\n verify:bundle FAILED:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`\n verify:bundle OK — core inlined, no residual bun: import (${(bundle.length / 1024).toFixed(0)} KiB)`);
