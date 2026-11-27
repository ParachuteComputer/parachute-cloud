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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "bun:test";
import {
  HOSTED_APP_CSP,
  SPA_CONNECT_SRC,
  extractInlineScripts,
  hostedCspAsked,
  sameCsp,
  spaCspFor,
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

// --- An app that says what it asks of a host (the Parachute app's web build) ---

// What ParachuteComputer/parachute's build writes into dist/hosted.json (its
// src/shell/hostedPolicy.ts): copied here as that build printed it, so a change
// on either side shows as a failure, not as a silent new policy.
const APP_ASKS =
  "default-src 'self'; connect-src 'self' https: wss:; img-src 'self' data: blob: https:; media-src 'self' data: blob:; " +
  "style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; font-src 'self' data:; frame-src about:; " +
  "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'";
const hosted = (csp: string, extra: Record<string, unknown> = {}) => JSON.stringify({ contract: 1, csp, spa: ["/"], ...extra });
const NO_INLINE = '<!doctype html><html><body><div id="root"></div><script type="module" src="/assets/index-abc.js"></script></body></html>';

describe("the policy for an app that says what it asks of a host", () => {
  it("is exactly what the Parachute app's build asks, and nothing wider", () => {
    expect(sameCsp(HOSTED_APP_CSP, APP_ASKS)).toBe(true);
    // applet frames are srcdoc documents with inline code that inherit the page's
    // policy: inline script stays, and frames can be about: documents only
    expect(HOSTED_APP_CSP).toContain("script-src 'self' 'unsafe-inline'");
    expect(HOSTED_APP_CSP).toContain("frame-src about:");
    expect(HOSTED_APP_CSP).not.toContain("unsafe-eval");
    expect(HOSTED_APP_CSP).not.toMatch(/script-src[^;]*(?:https?:|\*|data:|blob:)/);
    for (const d of ["default-src 'self'", "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'", "object-src 'none'"]) expect(HOSTED_APP_CSP).toContain(d);
  });

  it("sameCsp compares directives and sources in any order, and tells any difference", () => {
    expect(sameCsp("a 'self' x:; b y:", "b y: ; a x: 'self'")).toBe(true);
    expect(sameCsp(HOSTED_APP_CSP, `${HOSTED_APP_CSP}; worker-src 'self'`)).toBe(false);
    expect(sameCsp(HOSTED_APP_CSP, HOSTED_APP_CSP.replace("frame-src about:", "frame-src about: https:"))).toBe(false);
    expect(sameCsp(HOSTED_APP_CSP, HOSTED_APP_CSP.replace("; object-src 'none'", ""))).toBe(false);
    // a directive named twice: a browser takes the first, so it is never "the same"
    expect(sameCsp(`script-src *; ${HOSTED_APP_CSP}`, HOSTED_APP_CSP)).toBe(false);
    expect(sameCsp(`${HOSTED_APP_CSP}; script-src 'self' 'unsafe-inline'`, HOSTED_APP_CSP)).toBe(false);
    // only ASCII whitespace separates sources (a no-break space doesn't)
    expect(sameCsp(HOSTED_APP_CSP.replace("frame-src about:", "frame-src\u00a0about:"), HOSTED_APP_CSP)).toBe(false);
  });

  it("reads a declaration only when it is one: contract 1 with a csp", () => {
    expect(hostedCspAsked(hosted(APP_ASKS))).toBe(APP_ASKS);
    // a missing hosted.json comes back from Static Assets as the app's page
    for (const not of [null, "", NO_INLINE, "{}", JSON.stringify({ contract: 2, csp: APP_ASKS }), JSON.stringify({ contract: 1, csp: 7 }), "[1]"]) expect(hostedCspAsked(not)).toBeNull();
  });

  it("the worker and _headers send Cloud's policy for it, never one read from the bundle", async () => {
    expect(await spaCspFor(NO_INLINE, hosted(APP_ASKS))).toBe(HOSTED_APP_CSP);
    // a bundle that asks for anything else (the build refuses it first: below) never gets it at the worker either:
    // it keeps the hash-locked policy
    for (const other of [`${APP_ASKS}; worker-src *`, APP_ASKS.replace("frame-src about:", "frame-src *"), ""]) expect(await spaCspFor(NO_INLINE, hosted(other))).toBe(spaContentSecurityPolicy([]));
    // the older app: no declaration, the hash-locked policy as before
    expect(await spaCspFor(FIXTURE, null)).toBe(spaContentSecurityPolicy([THEME_SCRIPT_HASH]));
    expect(await spaCspFor(FIXTURE, NO_INLINE)).toBe(spaContentSecurityPolicy([THEME_SCRIPT_HASH]));
    const headers = await renderSpaHeadersFile(NO_INLINE, hosted(APP_ASKS));
    expect(headers).toContain(`/*\n  Content-Security-Policy: ${HOSTED_APP_CSP}\n`);
    expect(headers.split("\n").filter((l) => l.startsWith("/"))).toEqual(["/*"]);
  });
});

describe("scripts/gen-spa-headers.ts", () => {
  const dirs: string[] = [];
  afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
  const gen = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), "parachute-cloud-spa-headers-"));
    dirs.push(dir);
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    const r = Bun.spawnSync(["bun", join(import.meta.dir, "../scripts/gen-spa-headers.ts"), dir], { stdout: "pipe", stderr: "pipe" });
    let headers: string | null = null;
    try { headers = readFileSync(join(dir, "_headers"), "utf8"); } catch { /* none written */ }
    return { code: r.exitCode, err: r.stderr.toString(), headers };
  };

  it("writes Cloud's policy for a build that asks for exactly it", () => {
    const r = gen({ "index.html": NO_INLINE, "hosted.json": hosted(APP_ASKS) });
    expect(r.code).toBe(0);
    expect(r.headers).toContain(HOSTED_APP_CSP);
  });

  it("refuses a build that asks for a policy Cloud hasn't reviewed, and says both", () => {
    const wider = APP_ASKS.replace("frame-src about:", "frame-src about: https:");
    const r = gen({ "index.html": NO_INLINE, "hosted.json": hosted(wider) });
    expect(r.code).not.toBe(0);
    expect(r.headers).toBeNull();
    expect(r.err).toContain("asks for a policy Cloud hasn't reviewed");
    expect(r.err).toContain("frame-src about: https:");
  });

  it("refuses a hosted.json it can't read as a declaration, and a page with neither a declaration nor an inline script", () => {
    expect(gen({ "index.html": NO_INLINE, "hosted.json": "{}" }).code).not.toBe(0);
    const bare = gen({ "index.html": NO_INLINE });
    expect(bare.code).not.toBe(0);
    expect(bare.err).toContain("no inline <script>");
  });

  it("the older app: the hash-locked policy from its own page, as before", () => {
    const r = gen({ "index.html": FIXTURE });
    expect(r.code).toBe(0);
    expect(r.headers).toContain(THEME_SCRIPT_HASH);
    expect(r.headers).not.toMatch(/script-src[^;]*unsafe-inline/);
  });
});
