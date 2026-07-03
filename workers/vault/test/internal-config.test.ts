/**
 * Internal config seam — PUT/GET /vault/<name>/api/internal/config, the
 * platform-owned per-vault config endpoint the Identity Worker pushes plan
 * storage caps through (Wave 4 entitlements).
 *
 * The authorization matrix is the point of this suite: a vault OWNER can mint
 * `vault:<name>:admin` through the public OAuth flow, so the endpoint gates on
 * the FIRST-PARTY `client_id` claim (issuer-internal mints only; DCR ids are
 * server-generated UUIDs so no tenant client can carry it) — plus the
 * pre-existing VAULT_AUTH_TOKEN operator bearer. Also pinned here:
 *   - the pushed cap is ENFORCED (413 storage_cap_exceeded on note writes),
 *   - a cap RAISE lands even when the vault is already over cap (the endpoint
 *     dispatches before the cap gate — a plan upgrade must always work),
 *   - the resolved cap surfaces on the read-scoped vault landing (cap_bytes),
 *   - validation + persistence of the override.
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { FIRST_PARTY_CLIENT_ID } from "../src/auth.ts";
import { OP, base, createNote, freshVault, mintToken, op } from "./helpers.ts";

/** First-party admin token — exactly what identity's pushVaultCap mints. */
async function firstPartyToken(vault: string): Promise<string> {
  return mintToken({
    vault,
    scopes: `vault:${vault}:admin`,
    vaultScope: [vault],
    clientId: FIRST_PARTY_CLIENT_ID,
  });
}

function putConfig(vault: string, token: string, body: unknown): Promise<Response> {
  return SELF.fetch(`${base(vault)}/api/internal/config`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("internal config — authorization matrix", () => {
  it("first-party admin token (issuer mint shape) sets cap_bytes", async () => {
    const v = freshVault("ic");
    const res = await putConfig(v, await firstPartyToken(v), { cap_bytes: 104_857_600 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.name).toBe(v);
    expect(body.cap_bytes).toBe(104_857_600);
    expect(body.resolved_cap_bytes).toBe(104_857_600);
    expect(typeof body.used_bytes).toBe("number");
  });

  it("operator bearer (VAULT_AUTH_TOKEN) sets cap_bytes — the control-plane seam", async () => {
    const v = freshVault("ic");
    const res = await putConfig(v, OP, { cap_bytes: 5_000_000 });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).cap_bytes).toBe(5_000_000);
  });

  it("a TENANT-minted vault:<name>:admin token (no first-party client_id) is REFUSED", async () => {
    const v = freshVault("ic");
    // The exact shape a vault owner can obtain through the public OAuth flow:
    // admin verb, correct aud, correct vault_scope — but a DCR client_id.
    const tenantAdmin = await mintToken({
      vault: v,
      scopes: `vault:${v}:admin`,
      vaultScope: [v],
      clientId: "3f6a2e9b-1111-4222-8333-444455556666",
    });
    const res = await putConfig(v, tenantAdmin, { cap_bytes: 999_999_999_999 });
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error_type).toBe("internal_config_forbidden");
  });

  it("an admin token with NO client_id claim is refused too", async () => {
    const v = freshVault("ic");
    const bare = await mintToken({ vault: v, scopes: `vault:${v}:admin`, vaultScope: [v] });
    const res = await putConfig(v, bare, { cap_bytes: 1 });
    expect(res.status).toBe(403);
  });

  it("a first-party WRITE-verb token is refused (admin verb required)", async () => {
    const v = freshVault("ic");
    const writeOnly = await mintToken({
      vault: v,
      scopes: `vault:${v}:write`,
      vaultScope: [v],
      clientId: FIRST_PARTY_CLIENT_ID,
    });
    const res = await putConfig(v, writeOnly, { cap_bytes: 1_000_000 });
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error_type).toBe("internal_config_forbidden");
  });

  it("GET reports the usage split — db_bytes + r2_bytes = used_bytes (the daily rollup's read)", async () => {
    const v = freshVault("ic");
    // Materialize with real content so the SQLite size is nonzero.
    await createNote(v, { content: "some bytes so the database has a size" });
    const res = await SELF.fetch(`${base(v)}/api/internal/config`, {
      headers: { authorization: `Bearer ${await firstPartyToken(v)}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(typeof body.db_bytes).toBe("number");
    expect(body.db_bytes).toBeGreaterThan(0);
    // No attachments uploaded → the R2 meter is zero.
    expect(body.r2_bytes).toBe(0);
    expect(body.used_bytes).toBe(body.db_bytes + body.r2_bytes);
  });

  it("GET is gated the same way: first-party reads it, a tenant read token cannot", async () => {
    const v = freshVault("ic");
    await putConfig(v, await firstPartyToken(v), { cap_bytes: 7_000_000 });

    const fp = await SELF.fetch(`${base(v)}/api/internal/config`, {
      headers: { authorization: `Bearer ${await firstPartyToken(v)}` },
    });
    expect(fp.status).toBe(200);
    expect(((await fp.json()) as any).cap_bytes).toBe(7_000_000);

    const tenantRead = await mintToken({ vault: v, scopes: `vault:${v}:read`, vaultScope: [v] });
    const denied = await SELF.fetch(`${base(v)}/api/internal/config`, {
      headers: { authorization: `Bearer ${tenantRead}` },
    });
    expect(denied.status).toBe(403);
  });
});

describe("internal config — validation", () => {
  it("rejects a non-number, non-integer, zero, and negative cap_bytes", async () => {
    const v = freshVault("ic");
    const token = await firstPartyToken(v);
    for (const bad of ["100", 1.5, 0, -1, null]) {
      const res = await putConfig(v, token, { cap_bytes: bad });
      expect(res.status).toBe(400);
    }
    // Malformed JSON body.
    const raw = await SELF.fetch(`${base(v)}/api/internal/config`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "not json",
    });
    expect(raw.status).toBe(400);
  });
});

describe("internal config — the cap is real", () => {
  it("a pushed tiny cap 413s note writes; a raise clears it — even from OVER-cap", async () => {
    const v = freshVault("ic");
    // Materialize + baseline content, then push a cap below the current DB
    // size: the vault is instantly OVER cap.
    await createNote(v, { content: "baseline content before the cap lands" });
    const tiny = await putConfig(v, await firstPartyToken(v), { cap_bytes: 1024 });
    expect(tiny.status).toBe(200);

    // Byte-growing write → the documented 413 shape.
    const blocked = await op(v, "/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "no room at the inn" }),
    });
    expect(blocked.status).toBe(413);
    const err = (await blocked.json()) as any;
    expect(err.error_type).toBe("storage_cap_exceeded");
    expect(err.cap_bytes).toBe(1024);

    // THE PLAN-UPGRADE PATH: the vault is over cap, yet the cap raise itself
    // must land (internal config dispatches before the cap gate).
    const raise = await putConfig(v, await firstPartyToken(v), { cap_bytes: 100 * 1024 * 1024 });
    expect(raise.status).toBe(200);
    expect(((await raise.json()) as any).resolved_cap_bytes).toBe(100 * 1024 * 1024);

    const unblocked = await op(v, "/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "room again after the upgrade" }),
    });
    expect(unblocked.status).toBe(201);
  });

  it("the override persists in DO config and the landing surfaces the RESOLVED cap", async () => {
    const v = freshVault("ic");
    // Before any override: the landing resolves to the env default (2MB in
    // the test bindings).
    const before = await op(v, "");
    expect(((await before.json()) as any).cap_bytes).toBe(2_000_000);

    await putConfig(v, await firstPartyToken(v), { cap_bytes: 104_857_600 });

    // Read-scoped tenant view: GET /vault/<name> carries the effective quota.
    const token = await mintToken({ vault: v, scopes: `vault:${v}:read`, vaultScope: [v] });
    const landing = await SELF.fetch(`${base(v)}`, { headers: { authorization: `Bearer ${token}` } });
    expect(landing.status).toBe(200);
    expect(((await landing.json()) as any).cap_bytes).toBe(104_857_600);
  });
});
