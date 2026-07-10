/**
 * The SPA Content-Security-Policy (P1.1.5, parachute-cloud#116) — the pure
 * policy machinery shared by the two emitters (scripts/gen-spa-headers.ts →
 * dist-assets/_headers, and the worker's `/` Host-branch serveSpaShell).
 *
 * Runs under `bun test` (root suite): spa-csp.ts is pure TS (WebCrypto +
 * TextEncoder + btoa, all Bun globals) with no workerd deps, and the fixture is
 * a committed copy of a real built index.html — so this passes in ci.yml's root
 * job, which never builds the gitignored dist-assets. The live-served hash is
 * derived at build time (never hardcoded), so this fixture pins the EXTRACTION +
 * HASH machinery, not the moving app version.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import {
  SPA_CONNECT_SRC,
  extractInlineScripts,
  inlineScriptHashes,
  renderSpaHeadersFile,
  sha256Base64,
  spaContentSecurityPolicy,
} from "../workers/identity/src/spa-csp.ts";

// A committed copy of a real notes-ui build's index.html (v0.1.23). Its ONE
// inline <script> is the theme bootstrap; its hash is verified byte-exact
// against `openssl dgst -sha256` below.
const FIXTURE = readFileSync(join(import.meta.dir, "fixtures/spa-index.html"), "utf8");
// The inline theme-bootstrap hash — independently cross-checked with
// `openssl dgst -sha256 -binary <script-body> | openssl base64`.
const THEME_SCRIPT_HASH = "sha256-Fv2E1CthteztNbE8WHFN1BtSMkylyLFARPEtyOa8Q2U=";

describe("extractInlineScripts — byte-exact inline bodies (P1.1.5)", () => {
  it("returns exactly the one inline <script>, skipping the external module", () => {
    const scripts = extractInlineScripts(FIXTURE);
    expect(scripts).toHaveLength(1);
    // The captured body is what the browser hashes: between `>` and `</script>`.
    expect(scripts[0]).toContain('localStorage.getItem("lens:theme")');
    // Positive control that the external <script src=…> was NOT captured.
    expect(scripts[0]).not.toContain("assets/index-");
  });

  it("skips external scripts regardless of attribute order (src first or last)", () => {
    expect(extractInlineScripts('<script src="/a.js"></script>')).toEqual([]);
    expect(extractInlineScripts('<script type="module" crossorigin src="/a.js"></script>')).toEqual([]);
    expect(extractInlineScripts("<script>doThing()</script>")).toEqual(["doThing()"]);
  });
});

describe("the inline-script hash matches the real bytes (P1.1.5)", () => {
  it("hashes the fixture's theme script to the cross-checked sha256", async () => {
    const hashes = await inlineScriptHashes(FIXTURE);
    expect(hashes).toEqual([THEME_SCRIPT_HASH]);
  });

  it("sha256Base64 is a correct WebCrypto digest (positive control)", async () => {
    // RFC-known vector: sha256("") base64.
    expect(await sha256Base64("")).toBe("47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=");
  });
});

describe("spaContentSecurityPolicy — the policy string (P1.1.5)", () => {
  const csp = spaContentSecurityPolicy([THEME_SCRIPT_HASH]);

  it("locks script-src: 'self' + the inline hash, NO unsafe-inline/eval", () => {
    expect(csp).toContain(`script-src 'self' '${THEME_SCRIPT_HASH}'`);
    expect(csp).not.toContain("unsafe-eval");
    // 'unsafe-inline' appears for STYLE, never for script — assert the script
    // directive itself carries no 'unsafe-inline'.
    const scriptDirective = csp.split("; ").find((d) => d.startsWith("script-src "));
    expect(scriptDirective).not.toContain("unsafe-inline");
  });

  it("carries the WIDE connect-src tier (PW4/D10): 'self' https: wss:", () => {
    expect(csp).toContain(`connect-src ${SPA_CONNECT_SRC.join(" ")}`);
    expect(csp).toContain("connect-src 'self' https: wss:");
  });

  it("permits the SPA's passive resources (blob:/https: attachments + remote md)", () => {
    expect(csp).toContain("img-src 'self' data: blob: https:");
    expect(csp).toContain("media-src 'self' blob: https:");
    expect(csp).toContain("frame-src 'self' blob:"); // PDF attachment iframe
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("font-src 'self' data:");
    expect(csp).toContain("manifest-src 'self'"); // PWA manifest
    expect(csp).toContain("worker-src 'self'"); // service worker
  });

  it("keeps the hard locks", () => {
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self'");
  });

  it("with no inline script → a valid script-src 'self' (no dangling quotes)", () => {
    expect(spaContentSecurityPolicy([])).toContain("script-src 'self';");
  });
});

describe("renderSpaHeadersFile — the _headers body (P1.1.5)", () => {
  it("applies the SPA CSP to /* with the fixture's real hash", async () => {
    const headers = await renderSpaHeadersFile(FIXTURE);
    expect(headers).toContain("/*\n  Content-Security-Policy: ");
    expect(headers).toContain(THEME_SCRIPT_HASH);
    expect(headers).toContain("connect-src 'self' https: wss:");
    // The ONLY path rule is `/*` — no rule targets a ceremony prefix, so
    // `_headers` can't weaken the worker-served P0.2 CSP. (Rules are the lines
    // that start with `/`; comment lines start with `#`.)
    const ruleLines = headers.split("\n").filter((l) => l.startsWith("/"));
    expect(ruleLines).toEqual(["/*"]);
  });
});
