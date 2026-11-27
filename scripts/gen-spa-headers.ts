#!/usr/bin/env bun
/**
 * gen-spa-headers.ts — emit `dist-assets/_headers` with the SPA
 * Content-Security-Policy (P1.1.5, parachute-cloud#116).
 *
 * Run by scripts/build-spa.sh AFTER the pinned app's build has been copied
 * into dist-assets. For an app that says what it asks of a host
 * (`hosted.json`, the Parachute app's web build) the policy is Cloud's own
 * for it, written only when it is exactly what that build asks. For the
 * older app the inline-script hash is derived from the ACTUAL
 * built `index.html` — never a hardcoded hash that could drift from what's
 * served (the deploy tracks the pinned commit in scripts/spa-source.env, so
 * the built shell still moves under us on every pin bump). The policy
 * directives live in workers/identity/src/spa-csp.ts, shared verbatim with
 * the worker's `/` Host-branch (serveSpaShell).
 *
 * Usage: `bun scripts/gen-spa-headers.ts [dist-assets-dir]`
 * (defaults to workers/identity/dist-assets).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOSTED_APP_CSP, hostedCspAsked, inlineScriptHashes, renderSpaHeadersFile, sameCsp } from "../workers/identity/src/spa-csp.ts";

const distAssets = process.argv[2] ?? join(import.meta.dir, "../workers/identity/dist-assets");
const indexPath = join(distAssets, "index.html");
const indexHtml = readFileSync(indexPath, "utf8");
const hostedPath = join(distAssets, "hosted.json");
const hostedJson = existsSync(hostedPath) ? readFileSync(hostedPath, "utf8") : null;
const asked = hostedCspAsked(hostedJson);

if (hostedJson !== null && asked === null) {
  console.error(`gen-spa-headers: ${hostedPath} is not a declaration this script reads (contract 1 with a csp) — refusing to guess a policy.`);
  process.exit(1);
}
if (asked !== null) {
  // An app that says what it asks of a host: Cloud sends its own reviewed policy
  // for it, and only when that is exactly what this build asks. A build that asks
  // for anything else stops here, loudly, until someone reads the difference.
  if (!sameCsp(asked, HOSTED_APP_CSP)) {
    console.error(
      "gen-spa-headers: the pinned app asks for a policy Cloud hasn't reviewed.\n" +
        `  the build asks: ${asked}\n  Cloud sends:    ${HOSTED_APP_CSP}\n` +
        "Read the difference, then change HOSTED_APP_CSP in workers/identity/src/spa-csp.ts (with its tests) or the pin.",
    );
    process.exit(1);
  }
  writeFileSync(join(distAssets, "_headers"), await renderSpaHeadersFile(indexHtml, hostedJson));
  console.log(`gen-spa-headers: wrote ${join(distAssets, "_headers")} — the policy the build's hosted.json asks for`);
  process.exit(0);
}

// Positive control: the whole point of the older app's CSP is to admit the ONE
// inline bootstrap script by hash. If the extractor finds none, either the shell
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
