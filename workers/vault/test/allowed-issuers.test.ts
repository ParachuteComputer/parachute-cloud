import { describe, it, expect } from "vitest";
import { SignJWT, importJWK, generateKeyPair } from "jose";
import { authenticateVaultToken } from "../src/auth.ts";
import type { Env } from "../src/env.ts";
import { TEST_PRIVATE_JWK, TEST_PUBLIC_JWKS, TEST_KID } from "./test-keys.ts";

/**
 * P0.1 — set-tolerant issuer acceptance (`ALLOWED_ISSUERS`).
 *
 * The vault worker validates a token's `iss` against ISSUER_ORIGIN ∪
 * ALLOWED_ISSUERS. This suite pins the acceptance set behavior directly through
 * `authenticateVaultToken` — the router-path conformance suite is bound to a
 * single miniflare env (ALLOWED_ISSUERS unset), so it doubles as the regression
 * pin that "unset var = today's single-origin match"; these tests vary the var
 * per case, which the router path can't.
 *
 * All tokens share ONE static key set (TEST_JWKS) regardless of `iss` — exactly
 * the prod topology (one JWKS, several of the hub's own origins). The foreign-key
 * case pins scope-guard's signature-first guarantee: a matching `iss` never
 * rescues a token signed by a key the JWKS doesn't carry.
 */

const PRIMARY = "https://id.test.example"; // ISSUER_ORIGIN (the canonical hubOrigin)
const SECOND = "https://app.test.example"; // an additional hub origin (the app. analog)
const THIRD = "https://elsewhere.test.example"; // never listed

/** A vault-worker env for the direct auth path. Only the auth-relevant vars matter. */
function envWith(allowed?: string): Env {
  return {
    ISSUER_ORIGIN: PRIMARY,
    ENVIRONMENT: "test",
    TEST_JWKS: TEST_PUBLIC_JWKS,
    ...(allowed !== undefined ? { ALLOWED_ISSUERS: allowed } : {}),
  } as unknown as Env;
}

let seq = 0;
function freshVault(): string {
  return `v${Date.now().toString(36)}${seq++}`;
}

async function mint(opts: {
  vault: string;
  iss: string;
  signingKey?: Awaited<ReturnType<typeof importJWK>>;
  kid?: string;
  scopes?: string;
}): Promise<string> {
  const key = opts.signingKey ?? (await importJWK(TEST_PRIVATE_JWK as any, "RS256"));
  return new SignJWT({ scope: opts.scopes ?? `vault:${opts.vault}:read` })
    .setProtectedHeader({ alg: "RS256", kid: opts.kid ?? TEST_KID })
    .setIssuer(opts.iss)
    .setAudience(`vault.${opts.vault}`)
    .setSubject("user-1")
    .setJti(`jti-${Math.random().toString(36).slice(2)}`)
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(key);
}

describe("ALLOWED_ISSUERS — set-tolerant issuer acceptance (P0.1)", () => {
  it("unset var: ISSUER_ORIGIN token accepted (today's behavior, byte-identical)", async () => {
    const v = freshVault();
    const token = await mint({ vault: v, iss: PRIMARY });
    const res = await authenticateVaultToken(token, envWith(undefined), v);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.auth.permission).toBe("read");
  });

  it("unset var: a second issuer is REFUSED (the set is just ISSUER_ORIGIN)", async () => {
    const v = freshVault();
    const token = await mint({ vault: v, iss: SECOND });
    const res = await authenticateVaultToken(token, envWith(undefined), v);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("unauthorized");
  });

  it("empty var behaves exactly like unset (blanks dropped → single origin)", async () => {
    const v = freshVault();
    const primary = await authenticateVaultToken(await mint({ vault: v, iss: PRIMARY }), envWith("  ,  "), v);
    const second = await authenticateVaultToken(await mint({ vault: v, iss: SECOND }), envWith("  ,  "), v);
    expect(primary.ok).toBe(true);
    expect(second.ok).toBe(false);
  });

  it("var carries a second issuer: a token under THAT issuer is accepted", async () => {
    const v = freshVault();
    const token = await mint({ vault: v, iss: SECOND });
    const res = await authenticateVaultToken(token, envWith(SECOND), v);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.auth.permission).toBe("read");
  });

  it("var carries a second issuer: ISSUER_ORIGIN STILL accepted (union with hubOrigin)", async () => {
    const v = freshVault();
    const token = await mint({ vault: v, iss: PRIMARY });
    const res = await authenticateVaultToken(token, envWith(SECOND), v);
    expect(res.ok).toBe(true);
  });

  it("var carries a second issuer: an UNLISTED third issuer is refused", async () => {
    const v = freshVault();
    const token = await mint({ vault: v, iss: THIRD });
    const res = await authenticateVaultToken(token, envWith(SECOND), v);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("unauthorized");
  });

  it("comma-separated set with whitespace + trailing slashes is normalized", async () => {
    const v = freshVault();
    // Listed with a trailing slash and padding; the token's iss has neither.
    const env = envWith(` ${SECOND}/ , ${THIRD} `);
    const second = await authenticateVaultToken(await mint({ vault: v, iss: SECOND }), env, v);
    const third = await authenticateVaultToken(await mint({ vault: v, iss: THIRD }), env, v);
    expect(second.ok).toBe(true);
    expect(third.ok).toBe(true);
  });

  it("signature-first: a FOREIGN-key token is refused even with a LISTED iss (F8)", async () => {
    const v = freshVault();
    // A key the JWKS does not carry; reuse the real kid so the failure is the
    // signature check, not a kid miss. iss = ISSUER_ORIGIN (always in the set).
    const foreign = await generateKeyPair("RS256");
    const token = await mint({ vault: v, iss: PRIMARY, signingKey: foreign.privateKey, kid: TEST_KID });
    const res = await authenticateVaultToken(token, envWith(SECOND), v);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("unauthorized");
  });
});
