import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { freshVault, ISSUER } from "./helpers.ts";

/**
 * OAuth discovery conformance (design §3.1). The chain a spec-following MCP
 * client walks: 401 → PRM (names the authorization server + narrowed scopes) →
 * AS metadata (the Identity Worker's endpoints). Ground truth: bun's
 * oauth-discovery.ts + routing.ts (both RFC path shapes) — with the two cloud
 * divergences (issuer = Identity Worker; scopes narrowed to read/write).
 */

describe("discovery — protected resource metadata (RFC 9728)", () => {
  it("insertion form /.well-known/oauth-protected-resource/vault/<name>/mcp is public + correct", async () => {
    const v = freshVault();
    const res = await SELF.fetch(`https://vault.test/.well-known/oauth-protected-resource/vault/${v}/mcp`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const body = (await res.json()) as any;
    expect(body.resource).toBe(`https://vault.test/vault/${v}/mcp`);
    expect(body.authorization_servers).toEqual([ISSUER]);
    expect(body.scopes_supported).toEqual([`vault:${v}:read`, `vault:${v}:write`]);
    expect(body.bearer_methods_supported).toEqual(["header"]);
  });

  it("append form /vault/<name>/.well-known/oauth-protected-resource returns the same doc", async () => {
    const v = freshVault();
    const insert = await (await SELF.fetch(`https://vault.test/.well-known/oauth-protected-resource/vault/${v}/mcp`)).json();
    const append = await (await SELF.fetch(`https://vault.test/vault/${v}/.well-known/oauth-protected-resource`)).json();
    expect(append).toEqual(insert);
  });

  it("subdomain addressing → resource + name resolve from the host", async () => {
    const v = freshVault("sub");
    const res = await SELF.fetch(`https://${v}.u.parachute.computer/.well-known/oauth-protected-resource/mcp`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    // Cloud always advertises the path-form resource URL (both modes route it).
    expect(body.resource).toBe(`https://${v}.u.parachute.computer/vault/${v}/mcp`);
    expect(body.scopes_supported).toEqual([`vault:${v}:read`, `vault:${v}:write`]);
  });
});

describe("discovery — authorization server metadata (RFC 8414 forwarder)", () => {
  it("names the Identity Worker's endpoints", async () => {
    const v = freshVault();
    const res = await SELF.fetch(`https://vault.test/.well-known/oauth-authorization-server/vault/${v}/mcp`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.issuer).toBe(ISSUER);
    expect(body.authorization_endpoint).toBe(`${ISSUER}/oauth/authorize`);
    expect(body.token_endpoint).toBe(`${ISSUER}/oauth/token`);
    expect(body.registration_endpoint).toBe(`${ISSUER}/oauth/register`);
    expect(body.jwks_uri).toBe(`${ISSUER}/.well-known/jwks.json`);
    expect(body.code_challenge_methods_supported).toEqual(["S256"]);
    expect(body.scopes_supported).toEqual([`vault:${v}:read`, `vault:${v}:write`]);
  });

  it("append form resolves too", async () => {
    const v = freshVault();
    const res = await SELF.fetch(`https://vault.test/vault/${v}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    expect((await res.json() as any).issuer).toBe(ISSUER);
  });
});
