/**
 * Shared conformance-test helpers — token minting + request builders, extracted
 * so the feature suites (mcp / discovery / subscribe / export) share one path
 * with the base conformance suite's conventions (operator bearer, per-test fresh
 * vault via a unique idFromName, JWT minting against the static TEST_JWKS).
 */
import { SELF } from "cloudflare:test";
import { SignJWT, importJWK } from "jose";
import { TEST_PRIVATE_JWK, TEST_KID } from "./test-keys.ts";

export const ISSUER = "https://id.test.example";
export const OP = "test-operator-token";

let seq = 0;
export function freshVault(prefix = "v"): string {
  return `${prefix}${Date.now().toString(36)}${seq++}`;
}

export function base(vault: string): string {
  return `https://vault.test/vault/${vault}`;
}

export async function mintToken(opts: {
  vault: string;
  scopes: string;
  sub?: string;
  aud?: string;
  iss?: string;
  vaultScope?: string[];
  expiresIn?: string;
  kid?: string;
}): Promise<string> {
  const key = await importJWK(TEST_PRIVATE_JWK as any, "RS256");
  return new SignJWT({
    scope: opts.scopes,
    ...(opts.vaultScope ? { vault_scope: opts.vaultScope } : {}),
  })
    .setProtectedHeader({ alg: "RS256", kid: opts.kid ?? TEST_KID })
    .setIssuer(opts.iss ?? ISSUER)
    .setAudience(opts.aud ?? `vault.${opts.vault}`)
    .setSubject(opts.sub ?? "user-1")
    .setJti(`jti-${Math.random().toString(36).slice(2)}`)
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? "15m")
    .sign(key);
}

/** Operator-token request against a vault path. */
export function op(vault: string, path: string, init: any = {}): Promise<Response> {
  const headers: Record<string, string> = { Authorization: `Bearer ${OP}`, ...(init.headers ?? {}) };
  return SELF.fetch(`${base(vault)}${path}`, { ...init, headers });
}

export async function createNote(vault: string, body: Record<string, unknown>): Promise<any> {
  const res = await op(vault, "/api/notes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status !== 201) throw new Error(`createNote → ${res.status}: ${await res.text()}`);
  return res.json();
}
