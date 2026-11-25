/**
 * Shared conformance-test helpers — token minting + request builders, extracted
 * so the feature suites (mcp / discovery / subscribe / export) share one path
 * with the base conformance suite's conventions (operator bearer, per-test fresh
 * vault via a unique idFromName, JWT minting against the static TEST_JWKS).
 */
import { SELF } from "cloudflare:test";
import { SignJWT, importJWK } from "jose";
import { TEST_PRIVATE_JWK, TEST_KID } from "./test-keys.ts";
import { expect } from "vitest";

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
  /** `client_id` claim — the internal-config seam gates on the first-party id. */
  clientId?: string;
  /**
   * Raw `permissions` claim. The vault reads `principal_pubkey` off it for
   * NIP-98 write attribution (cloud#277); scope-guard passes it through
   * verbatim.
   */
  permissions?: unknown;
  /** Raw top-level `key` claim (the write stamp's `{name, kind}`, Parachute 0.9.1). */
  key?: unknown;
}): Promise<string> {
  const key = await importJWK(TEST_PRIVATE_JWK as any, "RS256");
  return new SignJWT({
    scope: opts.scopes,
    ...(opts.vaultScope ? { vault_scope: opts.vaultScope } : {}),
    ...(opts.clientId ? { client_id: opts.clientId } : {}),
    ...(opts.permissions !== undefined ? { permissions: opts.permissions } : {}),
    ...(opts.key !== undefined ? { key: opts.key } : {}),
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

/**
 * One way to refuse (T-476, core mcp-refusal.ts): a tools/call refusal is a normal result, `isError: true`, with
 * `structuredContent {error_type, message, ...fields}` and one text block that is that object as JSON; never a JSON-RPC
 * error. Asserts the whole shape and the type, and returns the refusal (its fields) for the test's own checks.
 */
export function refused(body: any, error_type: string): Record<string, any> {
  expect(body?.error).toBeUndefined();
  expect(body?.result?.isError).toBe(true);
  const sc = body.result.structuredContent;
  expect(sc?.error_type).toBe(error_type);
  expect(typeof sc.message).toBe("string");
  expect(sc.message).not.toMatch(/^(MCP error|\[)/);
  expect(body.result.content).toHaveLength(1);
  expect(JSON.parse(body.result.content[0].text)).toEqual(sc);
  return sc;
}
