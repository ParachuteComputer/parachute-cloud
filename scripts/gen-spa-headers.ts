#!/usr/bin/env bun
/**
 * gen-spa-headers.ts — emit `dist-assets/_headers` with the SPA
 * Content-Security-Policy (P1.1.5, parachute-cloud#116).
 *
 * Run by scripts/build-spa.sh AFTER the parachute-app build has been copied
 * into dist-assets, so the inline-script hash is derived from the ACTUAL
 * built `index.html` — never a hardcoded hash that could drift from what's
 * served (the deploy tracks the pinned commit in scripts/spa-source.env, so
 * the built shell still moves under us on every pin bump). The policy
 * directives live in workers/identity/src/spa-csp.ts, shared verbatim with
 * the worker's `/` Host-branch (serveSpaShell).
 *
 * Usage: `bun scripts/gen-spa-headers.ts [dist-assets-dir]`
 * (defaults to workers/identity/dist-assets).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inlineScriptHashes, renderSpaHeadersFile } from "../workers/identity/src/spa-csp.ts";

const distAssets = process.argv[2] ?? join(import.meta.dir, "../workers/identity/dist-assets");
const indexPath = join(distAssets, "index.html");
const indexHtml = readFileSync(indexPath, "utf8");

// Positive control: the whole point of the CSP is to admit the ONE inline
// bootstrap script by hash. If the extractor finds none, either the shell
// changed shape or the regex is broken — either way, emitting a CSP that would
// silently BLOCK the theme bootstrap is worse than failing the build loudly.
const hashes = await inlineScriptHashes(indexHtml);
if (hashes.length === 0) {
  console.error(
    `gen-spa-headers: no inline <script> found in ${indexPath} — refusing to emit a CSP ` +
      "that would block the theme bootstrap. Did index.html change shape?",
  );
  process.exit(1);
}

writeFileSync(join(distAssets, "_headers"), await renderSpaHeadersFile(indexHtml));
console.log(`gen-spa-headers: wrote ${join(distAssets, "_headers")} — script-src ${hashes.join(" ")}`);
