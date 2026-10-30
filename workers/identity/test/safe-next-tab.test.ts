/**
 * safeNext must not let an ASCII tab (or LF/CR) smuggle a protocol-relative
 * redirect past its "leading slash, not followed by / or \" check.
 *
 * The WHATWG URL parser a browser uses on a `Location` header strips every
 * ASCII tab and newline from the input before parsing, so `/\t/evil.example`
 * resolves to `//evil.example` → `https://evil.example/`. A tab is legal inside
 * an HTTP header value, and workerd writes it to the wire as a raw 0x09
 * (checked against Miniflare + headless Chromium: the browser lands off-site).
 *
 * The exploit needs no access to the victim's browser: anyone can request a
 * sign-in link for someone else's address with an attacker-chosen `next`
 * (stored on the link row), and the owner who clicks the genuine Parachute email
 * is signed in and then sent off-site. LF/CR/NUL can't make a header at all, so
 * the same stranger can make the owner's genuine link answer 500 after it has
 * been spent.
 */
import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import app from "../src/index.ts";
import { safeNext } from "../src/auth-handlers.ts";
import { CSRF, ISSUER, deps, seedSession, seedUser } from "./helpers.ts";

const VECTORS = [
  "/\t/evil.example/phish",
  "/\t\\evil.example/phish",
  "/\t\t/evil.example/phish",
  "/\n/evil.example/phish",
  "/\r/evil.example/phish",
  "/\r\n/evil.example/phish",
  "/\u0000/evil.example/phish",
];

/** Where a browser would actually land for this Location value. */
function browserTarget(location: string): string {
  return new URL(location, ISSUER).origin;
}

describe("safeNext: tab/newline cannot turn a relative path into an off-site redirect", () => {
  test("every vector resolves on the issuer origin and is a valid header value", () => {
    for (const v of VECTORS) {
      const out = safeNext(v, deps());
      expect(browserTarget(out), JSON.stringify(v)).toBe(ISSUER);
      expect(() => new Headers({ location: out }), JSON.stringify(v)).not.toThrow();
    }
  });

  test("ordinary same-origin targets still pass through unchanged", () => {
    for (const ok of [
      "/welcome",
      "/console/security",
      "/oauth/authorize?client_id=abc&redirect_uri=https%3A%2F%2Fapp.example%2Fcb&state=x%20y",
      `${ISSUER}/console`,
    ]) {
      expect(safeNext(ok, deps())).toBe(ok);
    }
  });

  test("a stranger's sign-in link request for the owner's address, opened by the owner, never leaves the origin", async () => {
    await seedUser("tab-victim@example.com", "correct horse");
    let i = 0;
    for (const evil of VECTORS) {
      i += 1;
      // The stranger's request: their own CSRF cookie, the victim's address.
      const send = await app.fetch(
        new Request(`${ISSUER}/auth/magic`, {
          method: "POST",
          body: JSON.stringify({ __csrf: CSRF, email: "tab-victim@example.com", next: evil }),
          headers: {
            "content-type": "application/json",
            origin: ISSUER,
            cookie: `parachute_id_csrf=${CSRF}`,
            "cf-connecting-ip": `10.99.0.${i}`,
            "x-requested-with": "fetch",
          },
        }),
        env,
      );
      expect(send.status).toBe(200);
      const link = send.headers.get("x-parachute-dev-magic-link");
      expect(link).toBeTruthy();
      // The owner opens the genuine email in their own browser (no cookies).
      const verify = await app.fetch(new Request(link!), env);
      expect(verify.status, JSON.stringify(evil)).toBe(302);
      expect(verify.headers.get("set-cookie") ?? "").toContain("parachute_id_session=");
      expect(browserTarget(verify.headers.get("location")!), JSON.stringify(evil)).toBe(ISSUER);
    }
  });

  test("logout's `next` gets the same fence", async () => {
    const { id } = await seedUser("tab-logout@example.com", "correct horse");
    for (const evil of VECTORS) {
      const sessionId = await seedSession(id);
      const res = await app.fetch(
        new Request(`${ISSUER}/logout`, {
          method: "POST",
          body: new URLSearchParams({ __csrf: CSRF, next: evil }),
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            origin: ISSUER,
            cookie: `parachute_id_session=${sessionId}; parachute_id_csrf=${CSRF}`,
          },
        }),
        env,
      );
      expect(res.status, JSON.stringify(evil)).toBe(302);
      expect(browserTarget(res.headers.get("location")!), JSON.stringify(evil)).toBe(ISSUER);
    }
  });
});
