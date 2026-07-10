/**
 * The SPA Content-Security-Policy (P1.1.5, parachute-cloud#116) — the policy the
 * notes-ui single-page app ships with, and the machinery to derive it from the
 * built `index.html`.
 *
 * ## Why this is separate from the ceremony CSP (P0.2)
 *
 * P0.2's `contentSecurityPolicy` (oauth-shared.ts) is the STRICT policy for the
 * server-rendered OAuth/console ceremonies: `default-src 'none'`, a per-response
 * script NONCE, `connect-src 'self'`. It rides `htmlResponse`, the single HTML
 * choke point every ceremony page funnels through.
 *
 * The SPA never touches `htmlResponse`. P1.1 serves `@openparachute/notes-ui`
 * from Workers Static Assets — its shell (`index.html`) and deep links bypass
 * the worker's HTML path entirely, so P0.2's CSP does NOT cover them. This module
 * is that missing policy, emitted through TWO surfaces that share it verbatim:
 *
 *   1. `scripts/gen-spa-headers.ts` writes it into `dist-assets/_headers`, which
 *      Cloudflare Static Assets applies to every asset-served response (the deep
 *      SPA links, `/oauth/callback`, the `/assets/*` bundle). `_headers` does
 *      NOT apply to worker-generated responses, so it never weakens the ceremony
 *      CSP — those routes are `run_worker_first` (worker-served).
 *   2. the identity worker's `serveSpaShell` (index.ts) stamps it on the `/`
 *      Host-branch response. `/` is `run_worker_first` (for the Host-branch), so
 *      the shell at the app's front door is worker-served via `env.ASSETS.fetch`
 *      — the one SPA response `_headers` can't be relied on to reach. The worker
 *      owns it explicitly (via {@link spaCspForHtml}) so `/` is guaranteed
 *      covered regardless of whether `_headers` flows through the ASSETS binding.
 *
 * Both surfaces derive the inline-script hash from the SAME built `index.html`
 * bytes, so they can never disagree about the policy.
 *
 * ## The two-tier connect-src (PW4) + the wide passive tiers (D10)
 *
 * The ceremonies fetch same-origin only → `connect-src 'self'`. The SPA is the
 * opposite: "Add a vault by URL" (D10, a permanent capability) means it connects
 * to VAULT data-plane APIs at ARBITRARY https origins the user names, over both
 * REST and the live-query WebSocket (`wss:`). So the SPA's `connect-src` is the
 * deliberate WIDE tier — `'self' https: wss:` — or the app simply can't reach
 * vaults. `img-src`/`media-src` are wide for the same reason: note markdown can
 * embed remote images and audio (`![](https://…)`), which render directly (only
 * `/api/storage/…` refs are auth-fetched into `blob:` URLs).
 *
 * The security value here is NOT connect-src (it must be wide) — it's the strict
 * `script-src`: `'self'` plus the exact sha256 of the ONE inline bootstrap
 * script, NO `'unsafe-inline'`, NO `'unsafe-eval'` (the bundle has neither, and
 * the highlight.js `wasm` grammar is a string, not real WebAssembly). Paired with
 * `object-src 'none'`, `base-uri 'self'`, and `frame-ancestors 'none'`, an
 * injected `<script>` cannot execute — the exposure the P1.1.5 blocker names.
 */

/**
 * The WIDE data-plane `connect-src` tier (PW4): the SPA reaches vault REST APIs
 * and their live-query WebSocket at arbitrary user-named origins (D10). `'self'`
 * for the SPA's own same-origin fetches + service worker; `https:` for any vault
 * REST origin; `wss:` for the live-query socket (ws-transport.ts derives `wss:`
 * from an `https:` vault origin).
 */
export const SPA_CONNECT_SRC = ["'self'", "https:", "wss:"] as const;

/**
 * Build the SPA Content-Security-Policy string from the inline-script hashes
 * (`sha256-…` tokens, no surrounding quotes). The directive list is the single
 * source of the policy — both emitters call this.
 *
 * Every directive is justified by an enumerated SPA resource (see the module
 * doc + the PR's per-resource table); the notable non-obvious ones:
 *   - `script-src 'self' <hashes>` — the bundled `/assets/*.js` + the one inline
 *     theme bootstrap; no `'unsafe-inline'`/`'unsafe-eval'` (the lock that matters).
 *   - `style-src 'self' 'unsafe-inline'` — bundled CSS via `<link>` PLUS React
 *     `style={…}` attributes and a runtime-injected `<style>` (highlight.js);
 *     `'unsafe-inline'` covers both (style injection ≪ script injection).
 *   - `connect-src` — the WIDE tier ({@link SPA_CONNECT_SRC}).
 *   - `img-src` / `media-src` — `blob:` for auth-fetched attachments, `https:`
 *     for remote markdown images/audio, `data:` for inline/favicon images.
 *   - `frame-src 'self' blob:` — PDF attachments render in a `blob:` `<iframe>`.
 *   - `manifest-src`/`worker-src 'self'` — the PWA manifest + service worker.
 *   - `default-src 'self'` — the safe baseline for any resource type not named
 *     above (never silently cross-origin); the strict locks are explicit below.
 */
export function spaContentSecurityPolicy(scriptHashes: readonly string[]): string {
  const scriptSrc = ["'self'", ...scriptHashes.map((h) => `'${h}'`)].join(" ");
  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "media-src 'self' blob: https:",
    `connect-src ${SPA_CONNECT_SRC.join(" ")}`,
    "manifest-src 'self'",
    "worker-src 'self'",
    "frame-src 'self' blob:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
}

/**
 * Extract the byte-exact contents of every INLINE `<script>` (one with no `src`
 * attribute) from an HTML document. The bytes returned are exactly what a browser
 * hashes for a `script-src 'sha256-…'` match: everything between the opening
 * tag's `>` and the closing `</script>`. An external `<script src="…">` carries
 * no inline body to hash and is skipped.
 */
export function extractInlineScripts(html: string): string[] {
  const scripts: string[] = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] ?? "";
    if (/\bsrc\s*=/i.test(attrs)) continue; // external script — no inline body to hash
    scripts.push(m[2] ?? "");
  }
  return scripts;
}

/** SHA-256 of `text`, base64-encoded — the WebCrypto path (workerd + Bun/Node). */
export async function sha256Base64(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** The `sha256-…` CSP source tokens for every inline `<script>` in `html`. */
export async function inlineScriptHashes(html: string): Promise<string[]> {
  const scripts = extractInlineScripts(html);
  return Promise.all(scripts.map(async (s) => `sha256-${await sha256Base64(s)}`));
}

/**
 * The full SPA CSP string for a given built `index.html` — the inline-script
 * hash is derived from the actual bytes, so it can never drift from what's
 * served. Used by the worker's `/` Host-branch (index.ts serveSpaShell).
 */
export async function spaCspForHtml(html: string): Promise<string> {
  return spaContentSecurityPolicy(await inlineScriptHashes(html));
}

/**
 * Render the Cloudflare Static Assets `_headers` file body for a built
 * `index.html`. `/*` applies the SPA CSP to every asset-served response;
 * `_headers` never touches the worker-served (`run_worker_first`) ceremonies, so
 * this cannot weaken the P0.2 ceremony CSP. Used by scripts/gen-spa-headers.ts.
 */
export async function renderSpaHeadersFile(html: string): Promise<string> {
  const csp = await spaCspForHtml(html);
  return [
    "# Generated by scripts/gen-spa-headers.ts (P1.1.5) — do not edit by hand.",
    "# The SPA Content-Security-Policy for every Cloudflare Static-Assets-served",
    "# response (deep SPA links, /oauth/callback, /assets/*). run_worker_first",
    "# ceremonies are worker-served — _headers does not apply to them, so this",
    "# never weakens the P0.2 ceremony CSP.",
    "/*",
    `  Content-Security-Policy: ${csp}`,
    "",
  ].join("\n");
}
