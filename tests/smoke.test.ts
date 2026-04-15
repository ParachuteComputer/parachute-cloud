/**
 * Smoke tests for parachute-cloud.
 *
 * Runs against a live `wrangler dev` instance (cheaper than vitest-pool-workers).
 * Before running:
 *   1. `bun install`
 *   2. `cp .dev.vars.example .dev.vars`     (sets ENVIRONMENT=development + DO_INTERNAL_SECRET)
 *   3. `wrangler d1 migrations apply parachute-cloud-accounts --local`
 *   4. `wrangler dev` in another shell
 *   5. `bun test tests/smoke.test.ts`
 *
 * Aaron can skip these in CI until we wire a proper dev harness. The point is
 * to prove the wiring end-to-end: signup → vault token → DO round-trip.
 */

import { describe, it, expect } from "bun:test";

const BASE = process.env.CLOUD_BASE_URL ?? "http://127.0.0.1:8787";

// X-Dev-User is honored only when the server's ENVIRONMENT !== "production".
// That's a server-side check; here we just refuse to send it unless we're
// pointing at a non-production host (localhost or CLOUD_ENV=development).
const isLocal =
  BASE.includes("127.0.0.1") ||
  BASE.includes("localhost") ||
  process.env.CLOUD_ENV === "development";

async function dev(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (isLocal) headers.set("X-Dev-User", "smoke-user:smoke@dev.local");
  return fetch(`${BASE}${path}`, { ...init, headers });
}

describe("parachute-cloud smoke", () => {
  it("dispatcher health responds", async () => {
    const res = await fetch(`${BASE}/health`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean };
    expect(json.ok).toBe(true);
  });

  it("signup provisions a vault; returned apiToken round-trips /api/notes", async () => {
    const name = `smoke${Date.now().toString(36)}`;
    const signup = await dev("/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    expect(signup.status).toBe(201);
    const { hostname, apiToken } = (await signup.json()) as {
      hostname: string;
      apiToken: string;
    };
    expect(hostname).toBe(`${name}.parachute.computer`);
    expect(apiToken).toMatch(/^pvt_/);

    // No token → 401.
    const unauth = await fetch(`${BASE}/api/notes`, { headers: { Host: hostname } });
    expect(unauth.status).toBe(401);

    const list = await fetch(`${BASE}/api/notes`, {
      headers: { Host: hostname, Authorization: `Bearer ${apiToken}` },
    });
    expect(list.status).toBe(200);
    const { notes } = (await list.json()) as { notes: unknown[] };
    expect(Array.isArray(notes)).toBe(true);

    const create = await fetch(`${BASE}/api/notes`, {
      method: "POST",
      headers: {
        Host: hostname,
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiToken}`,
      },
      body: JSON.stringify({ content: "hello from smoke" }),
    });
    expect(create.status).toBe(201);
    const { note } = (await create.json()) as { note: { id: string; content: string } };
    expect(note.content).toBe("hello from smoke");
  });

  it("token management: list + create + revoke cycle, revoked token gets 401", async () => {
    // Signup a vault.
    const name = `tok${Date.now().toString(36)}`;
    const signup = await dev("/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    expect(signup.status).toBe(201);
    const { vaultId, hostname, apiToken } =
      (await signup.json()) as { vaultId: string; hostname: string; apiToken: string };

    // Verify initial token works.
    const initialCheck = await fetch(`${BASE}/api/notes`, {
      headers: { Host: hostname, Authorization: `Bearer ${apiToken}` },
    });
    expect(initialCheck.status).toBe(200);

    // Create a second token via dashboard route.
    const form = new URLSearchParams({ name: "laptop" });
    const create = await dev(`/dashboard/vaults/${vaultId}/tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      redirect: "manual",
    });
    // Hono redirects on success (302/303).
    expect([302, 303]).toContain(create.status);
    const loc = create.headers.get("Location") ?? "";
    const newToken = new URL(loc, BASE).searchParams.get("token");
    expect(newToken).toMatch(/^pvt_/);

    // New token works against the API.
    const useNew = await fetch(`${BASE}/api/notes`, {
      headers: { Host: hostname, Authorization: `Bearer ${newToken}` },
    });
    expect(useNew.status).toBe(200);

    // List tokens — should have default + laptop.
    const listPage = await dev(`/dashboard/vaults/${vaultId}/tokens`);
    expect(listPage.status).toBe(200);
    const html = await listPage.text();
    expect(html).toContain("laptop");
    expect(html).toContain("default");

    // Find the laptop token's id by asking the DO's internal list via a
    // second dev-authenticated create (we only need any non-default id for
    // the revoke test — scrape from HTML).
    const idMatch = html.match(/\/tokens\/([a-f0-9-]{36})\/revoke/);
    expect(idMatch).toBeTruthy();
    const tokenIdToRevoke = idMatch![1];

    // Revoke it.
    const revoke = await dev(
      `/dashboard/vaults/${vaultId}/tokens/${tokenIdToRevoke}/revoke`,
      { method: "POST", redirect: "manual" },
    );
    expect([302, 303]).toContain(revoke.status);

    // Which token did we revoke? The scraper grabs whichever row renders
    // first (newest = laptop token we just created). Confirm by hitting
    // the API with newToken — expect 401.
    const afterRevoke = await fetch(`${BASE}/api/notes`, {
      headers: { Host: hostname, Authorization: `Bearer ${newToken}` },
    });
    expect(afterRevoke.status).toBe(401);

    // Default token still works.
    const defaultStillWorks = await fetch(`${BASE}/api/notes`, {
      headers: { Host: hostname, Authorization: `Bearer ${apiToken}` },
    });
    expect(defaultStillWorks.status).toBe(200);
  });

  it("token management ownership: second user gets 404 on another user's tokens page", async () => {
    const name = `own${Date.now().toString(36)}`;
    const signup = await dev("/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    expect(signup.status).toBe(201);
    const { vaultId } = (await signup.json()) as { vaultId: string };

    // Hit the tokens page as a different dev user.
    const otherHeaders = new Headers({ "X-Dev-User": "other-user:other@dev.local" });
    const intruder = await fetch(`${BASE}/dashboard/vaults/${vaultId}/tokens`, {
      headers: otherHeaders,
    });
    // Ownership mismatch returns 404 (not 403) to avoid leaking vault IDs.
    expect(intruder.status).toBe(404);
  });
});
