/**
 * The kid derivation MUST match the hub's byte-for-byte:
 *   kid = base64url(SHA-256(public_key_pem))
 * (hub `signing-keys.ts` → `createHash("sha256").update(pem).digest("base64url")`).
 *
 * A resource server (vault/scribe) caches the JWKS and looks a key up by the
 * `kid` in a token's header; if the issuer derived the kid differently the
 * lookup misses and every token fails to verify. So we pin the algorithm three
 * ways: against a node-computed fixture (the hub's exact runtime), against an
 * independent WebCrypto reproduction, and against the live signed-token +
 * JWKS kids.
 */
import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { computeKid, getActiveSigningKey } from "../src/signing-keys.ts";
import { signAccessToken } from "../src/tokens.ts";
import { handleJwks } from "../src/oauth-metadata.ts";
import { decodeJwtPayload, deps } from "./helpers.ts";

/** The hub's algorithm, reproduced independently: base64url(SHA-256(utf8(pem))). */
async function hubComputeKid(pem: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pem));
  let binary = "";
  for (const b of new Uint8Array(digest)) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("kid derivation matches the hub byte-for-byte", () => {
  // Ground truth: node's `createHash("sha256").update(FIXTURE).digest("base64url")`
  // — the hub's exact runtime — computed once and pinned here.
  const FIXTURE_PEM =
    "-----BEGIN PUBLIC KEY-----\nFIXTURE-fixed-test-input-for-kid-derivation\n-----END PUBLIC KEY-----\n";
  const FIXTURE_KID = "MTM0pe-3ZkIEm9ppYUogIchL3DgASp5gxR4g7LprNF0";

  test("computeKid reproduces node's base64url(SHA-256(pem)) on a fixed fixture", async () => {
    expect(await computeKid(FIXTURE_PEM)).toBe(FIXTURE_KID);
    // And the independent WebCrypto reproduction agrees.
    expect(await hubComputeKid(FIXTURE_PEM)).toBe(FIXTURE_KID);
  });

  test("the active key's kid equals computeKid(its PEM)", async () => {
    const key = await getActiveSigningKey(env.DB);
    expect(key.kid).toBe(await computeKid(key.publicKeyPem));
    expect(key.kid).toBe(await hubComputeKid(key.publicKeyPem));
  });

  test("a signed token's header kid + the JWKS kid all agree with the active key", async () => {
    const key = await getActiveSigningKey(env.DB);
    const signed = await signAccessToken(env.DB, {
      sub: "u1",
      scopes: ["vault:default:read"],
      audience: "vault.default",
      clientId: "c1",
      issuer: deps().issuer,
    });
    const header = JSON.parse(atob(signed.token.split(".")[0]!.replace(/-/g, "+").replace(/_/g, "/")));
    expect(header.alg).toBe("RS256");
    expect(header.kid).toBe(key.kid);
    // The payload carries the standard claims (sanity — full claim assertions
    // live in the conformance suite).
    expect(decodeJwtPayload(signed.token).jti).toBe(signed.jti);

    const jwksRes = await handleJwks(env.DB);
    const jwks = (await jwksRes.json()) as { keys: Array<Record<string, unknown>> };
    const jwk = jwks.keys.find((k) => k.kid === key.kid);
    expect(jwk).toBeDefined();
    expect(jwk?.kty).toBe("RSA");
    expect(jwk?.alg).toBe("RS256");
    expect(jwk?.use).toBe("sig");
    expect(typeof jwk?.n).toBe("string");
    expect(jwk?.e).toBe("AQAB");
  });
});
