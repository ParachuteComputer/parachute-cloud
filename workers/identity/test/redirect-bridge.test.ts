/**
 * The `form-action 'self'` fix (P0 REVENUE): Chrome enforces `form-action`
 * against a form submission's ULTIMATE redirect destination, not just its
 * action URL, so a same-origin form whose response 30x's cross-origin
 * (OAuth consent approve/deny, Stripe Checkout/Portal, the app deep-links)
 * silently `net::ERR_ABORTED`s in Chrome even though the server fully
 * processed the POST. The fix keeps `form-action 'self'` STRICT and instead
 * routes those responses through a same-origin bridge page whose nonce'd
 * inline script continues the journey (`isCrossOrigin` + `renderRedirectBridge`,
 * oauth-shared.ts / ui.ts).
 *
 * Covers the mechanism directly (unit-level: the origin gate, the render
 * escaping) and end-to-end through the real router (the consent-approve leg
 * — nonce wiring, the script/fallback-link agreement, no open-redirect
 * surface).
 */
import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import app from "../src/index.ts";
import { NONCE_ATTR, htmlResponse, isCrossOrigin } from "../src/oauth-shared.ts";
import { renderRedirectBridge } from "../src/ui.ts";
import {
  CSRF,
  ISSUER,
  REDIRECT_URI,
  bridgeTarget,
  consentReq,
  makePkce,
  seedApprovedClient,
  seedSession,
  seedUser,
  seedVault,
} from "./helpers.ts";

// --- isCrossOrigin — the gate deciding direct-redirect vs bridge -------------

describe("isCrossOrigin", () => {
  test("same origin, same path/query → false", () => {
    expect(isCrossOrigin(`${ISSUER}/console?upgraded=1`, ISSUER)).toBe(false);
  });

  test("a bare relative path resolves against base → false", () => {
    expect(isCrossOrigin("/console", ISSUER)).toBe(false);
    expect(isCrossOrigin("/login/2fa", ISSUER)).toBe(false);
  });

  test("a different host → true", () => {
    expect(isCrossOrigin("https://checkout.stripe.com/c/test", ISSUER)).toBe(true);
    expect(isCrossOrigin("https://app.example/cb?code=abc", ISSUER)).toBe(true);
  });

  test("same host, different scheme or port → true (origin is scheme+host+port)", () => {
    const u = new URL(ISSUER);
    expect(isCrossOrigin(`http://${u.host}/console`, ISSUER)).toBe(true);
    expect(isCrossOrigin(`${u.protocol}//${u.hostname}:9999/console`, ISSUER)).toBe(true);
  });

  test("an unparseable location fails toward cross-origin (the safer, bridged path)", () => {
    expect(isCrossOrigin("not a url at all  ", "not a base either")).toBe(true);
  });
});

// --- renderRedirectBridge — the template + injection safety ------------------

describe("renderRedirectBridge", () => {
  const target = "https://app.example/cb?code=abc123&state=xyz";

  test("carries the NONCE_ATTR marker on its inline script (so htmlResponse nonces it)", () => {
    expect(renderRedirectBridge(target)).toContain(NONCE_ATTR);
  });

  test("the script's location.replace argument round-trips to the exact target", () => {
    const html = renderRedirectBridge(target);
    const m = html.match(/location\.replace\((.*)\);<\/script>/);
    expect(m).toBeTruthy();
    expect(JSON.parse(m![1]!)).toBe(target);
  });

  test("the fallback link's href carries the same target (HTML-escaped)", () => {
    const html = renderRedirectBridge(target);
    // & is the only HTML-special char in this particular target; esc() would
    // also entity-escape ", <, > if present (covered by the injection tests).
    expect(html).toContain(`href="${target.replace(/&/g, "&amp;")}"`);
  });

  test("INJECTION SAFETY: a target smuggling </script> cannot break out of the script tag", () => {
    const hostile = "https://app.example/cb?x=</script><script>alert(1)</script>";
    const html = renderRedirectBridge(hostile);
    // The JSON-encoded, <-escaped literal never contains a literal "</script>"
    // (only `<` needs escaping to break the sequence — `>` alone is inert).
    const scriptBody = html.match(/<script[^>]*>(.*?)<\/script>/s)![1]!;
    expect(scriptBody).not.toContain("</script>");
    expect(scriptBody).toContain("\\u003c/script>");
    // It still round-trips to the exact original string once JSON-parsed.
    const m = html.match(/location\.replace\((.*)\);<\/script>/);
    expect(JSON.parse(m![1]!)).toBe(hostile);
  });

  test("INJECTION SAFETY: a target with a raw quote cannot break out of the href attribute", () => {
    const hostile = 'https://app.example/cb?x="><script>alert(1)</script>';
    const html = renderRedirectBridge(hostile);
    // esc() turns the raw " into &quot; and < / > into entities, so no new
    // tag or attribute boundary can be opened from the target string.
    expect(html).not.toContain('href="https://app.example/cb?x="><script>alert(1)</script>"');
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
  });

  test("end-to-end through htmlResponse: header nonce and body nonce agree", async () => {
    const res = htmlResponse(renderRedirectBridge(target));
    const html = await res.text();
    const headerNonce = (res.headers.get("content-security-policy") ?? "").match(/'nonce-([^']+)'/)?.[1];
    expect(headerNonce).toBeTruthy();
    expect(html).toContain(`<script nonce="${headerNonce}">`);
    expect(html).not.toContain("__CSP_NONCE__");
  });
});

// --- renderRedirectBridge with clientName — the post-consent contract fix ---
// (auth redesign §5, task #34: the "Authorized, now what" dead end).

describe("renderRedirectBridge({ clientName }) — the client-aware post-consent screen", () => {
  const target = "https://app.example/cb?code=abc123&state=xyz";

  test("names the client in the heading, the manual link, and the watchdog copy", () => {
    const html = renderRedirectBridge(target, { clientName: "Claude" });
    expect(html).toContain("Taking you back to Claude…");
    expect(html).toContain(">Continue to Claude →<");
    // The watchdog text lives inside a JS string literal in the <script>
    // (JSON-escaped for that context), not HTML — the apostrophe is NOT an
    // HTML entity there.
    expect(html).toContain("You're connected. If nothing happened, switch back to Claude");
  });

  test("still carries the exact redirect target in both the script and the fallback link", () => {
    const html = renderRedirectBridge(target, { clientName: "Claude" });
    const scriptTarget = bridgeTarget(html);
    expect(scriptTarget).toBe(target);
    expect(html).toContain(`href="${target.replace(/&/g, "&amp;")}"`);
  });

  test("the watchdog fires 3 seconds after location.replace, not before — same-tab, deferred copy swap", () => {
    const html = renderRedirectBridge(target, { clientName: "Claude" });
    const m = html.match(/<script[^>]*>(.*)<\/script>/);
    expect(m).toBeTruthy();
    const scriptBody = m![1]!;
    // setTimeout(..., 3000) precedes location.replace textually — both fire
    // synchronously on script execution (replace() doesn't block), so ORDER
    // doesn't change behavior, but the watchdog's own delay does: it must be
    // gated on the literal 3000ms window, not fire immediately.
    expect(scriptBody).toMatch(/setTimeout\(function\(\)\{.*\},3000\);location\.replace\(/);
  });

  test("without clientName, the output is byte-identical to the original generic bridge (no watchdog, no regression for billing/console callers)", () => {
    expect(renderRedirectBridge(target)).toBe(renderRedirectBridge(target, {}));
    const html = renderRedirectBridge(target);
    expect(html).toContain("<h1>Redirecting…</h1>");
    expect(html).toContain("continue here");
    expect(html).not.toContain("setTimeout");
  });

  test("INJECTION SAFETY: an untrusted client_name (self-registered via DCR) is escaped everywhere it lands", () => {
    const hostile = '</script><script>alert(1)</script>"><img src=x>';
    const html = renderRedirectBridge(target, { clientName: hostile });
    // The heading + link land through esc() — no raw tag/attr breakout.
    expect(html).not.toContain("<img src=x>");
    expect(html).not.toContain("<script>alert(1)</script>");
    // The watchdog string is JSON+`<`-escaped, same discipline as the URL.
    const scriptBody = html.match(/<script[^>]*>(.*?)<\/script>/s)![1]!;
    expect(scriptBody).not.toContain("</script>");
  });
});

// --- end-to-end: the consent-approve leg names the client + carries the watchdog ---

describe("form-action fix + post-consent contract, end-to-end: the OAuth consent bridge is client-aware", () => {
  test("a NAMED client's display name appears on the bridge page + the watchdog copy", async () => {
    const { id: userId } = await seedUser("bridge-named@example.com");
    await seedVault("default", userId);
    const { clientId } = await seedApprovedClient({ clientName: "Test Connector" });
    const sessionId = await seedSession(userId);
    const { challenge } = await makePkce();
    const res = await app.fetch(
      consentReq(
        {
          client_id: clientId,
          redirect_uri: REDIRECT_URI,
          response_type: "code",
          scope: "vault:default:read",
          code_challenge: challenge,
          code_challenge_method: "S256",
        },
        { sessionId },
      ),
      env,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Taking you back to Test Connector…");
    expect(html).toContain("Continue to Test Connector →");
    expect(html).toContain("switch back to Test Connector");
    // The redirect target is still exactly right (the client-aware branch
    // didn't disturb the mechanism the earlier suite already pins).
    const target = bridgeTarget(html);
    expect(target).toBeTruthy();
    expect(new URL(target!).origin).toBe(new URL(REDIRECT_URI).origin);
    expect(new URL(target!).searchParams.get("code")).toBeTruthy();
  });

  test("an UNNAMED client (no client_name at registration) falls back to the generic bridge — no undefined/blank name leaks through", async () => {
    const { id: userId } = await seedUser("bridge-unnamed@example.com");
    await seedVault("default", userId);
    const { clientId } = await seedApprovedClient(); // no clientName
    const sessionId = await seedSession(userId);
    const { challenge } = await makePkce();
    const res = await app.fetch(
      consentReq(
        {
          client_id: clientId,
          redirect_uri: REDIRECT_URI,
          response_type: "code",
          scope: "vault:default:read",
          code_challenge: challenge,
          code_challenge_method: "S256",
        },
        { sessionId },
      ),
      env,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<h1>Redirecting…</h1>");
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("setTimeout");
  });
});

// --- end-to-end through the real router: the consent-approve leg ------------

describe("form-action fix, end-to-end: OAuth consent approve bridges past the cross-origin redirect_uri", () => {
  test("200 same-origin bridge — target in both the script and the fallback anchor, correct CSP nonce", async () => {
    const { id: userId } = await seedUser("bridge-e2e@example.com");
    await seedVault("default", userId);
    const { clientId } = await seedApprovedClient();
    const sessionId = await seedSession(userId);
    const { challenge } = await makePkce();
    const res = await app.fetch(
      new Request(`${ISSUER}/oauth/authorize`, {
        method: "POST",
        body: new URLSearchParams({
          __action: "consent",
          __csrf: CSRF,
          decision: "approve",
          client_id: clientId,
          redirect_uri: REDIRECT_URI,
          response_type: "code",
          scope: "vault:default:read",
          code_challenge: challenge,
          code_challenge_method: "S256",
        }),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: ISSUER,
          cookie: `parachute_id_session=${sessionId}; parachute_id_csrf=${CSRF}`,
        },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    // The page carries a one-time code — defense-in-depth against caching it.
    expect(res.headers.get("cache-control")).toBe("no-store");
    // A SAME-ORIGIN response (this page itself) — the whole point: form-action
    // 'self' is satisfied because the browser never sees a cross-origin
    // Location on the POST's own response.
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("form-action 'self'");
    const nonce = csp.match(/'nonce-([^']+)'/)?.[1];
    expect(nonce).toBeTruthy();

    const html = await res.text();
    // The target — the client's redirect_uri carrying a real code — appears
    // in BOTH the nonce'd script and the no-JS fallback link, and both agree.
    const scriptTarget = bridgeTarget(html);
    expect(scriptTarget).toBeTruthy();
    expect(new URL(scriptTarget!).origin).toBe(new URL(REDIRECT_URI).origin);
    expect(new URL(scriptTarget!).searchParams.get("code")).toBeTruthy();
    expect(html).toContain(`href="${scriptTarget!.replace(/&/g, "&amp;")}"`);
    expect(html).toContain(`<script nonce="${nonce}">`);
    // No un-nonced inline script slipped in alongside the bridge's own.
    const scriptTags = html.match(/<script\b[^>]*>/gi) ?? [];
    expect(scriptTags.every((t) => t.includes(`nonce="${nonce}"`))).toBe(true);
  });

  test("NO OPEN REDIRECT: the bridge target is always server-derived — nothing in the request body can steer it to an arbitrary host", async () => {
    const { id: userId } = await seedUser("no-open-redirect@example.com");
    await seedVault("default", userId);
    const { clientId } = await seedApprovedClient();
    const sessionId = await seedSession(userId);
    const { challenge } = await makePkce();
    // Attempt: smuggle an attacker-controlled destination via a field the
    // handler doesn't read for this purpose. There is no `?to=`/`next=`/
    // `redirect=` field the consent-submit handler consults for the bridge
    // target — it's built server-side from the CLIENT'S REGISTERED
    // redirect_uri (requireRegisteredRedirectUri) plus a freshly-minted code,
    // never echoed from an arbitrary request field.
    const res = await app.fetch(
      consentReq(
        {
          client_id: clientId,
          redirect_uri: REDIRECT_URI,
          response_type: "code",
          scope: "vault:default:read",
          code_challenge: challenge,
          code_challenge_method: "S256",
          // Extra, unrecognized fields an attacker might hope steer the
          // redirect — the handler only ever reads the registered params.
          to: "https://evil.example/steal",
          redirect: "https://evil.example/steal",
          next: "https://evil.example/steal",
        },
        { sessionId },
      ),
      env,
    );
    expect(res.status).toBe(200);
    const target = bridgeTarget(await res.text());
    expect(target).toBeTruthy();
    expect(new URL(target!).origin).toBe(new URL(REDIRECT_URI).origin);
    expect(target).not.toContain("evil.example");
  });

  test("an UNREGISTERED redirect_uri is refused BEFORE any bridge is ever rendered", async () => {
    const { id: userId } = await seedUser("bad-redirect@example.com");
    await seedVault("default", userId);
    const { clientId } = await seedApprovedClient();
    const sessionId = await seedSession(userId);
    const { challenge } = await makePkce();
    const res = await app.fetch(
      consentReq(
        {
          client_id: clientId,
          redirect_uri: "https://evil.example/steal",
          response_type: "code",
          scope: "vault:default:read",
          code_challenge: challenge,
          code_challenge_method: "S256",
        },
        { sessionId },
      ),
      env,
    );
    // requireRegisteredRedirectUri runs first — a 400 error PAGE (never a
    // redirect, bridged or otherwise) to an unregistered redirect_uri.
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).not.toContain("evil.example");
  });
});
