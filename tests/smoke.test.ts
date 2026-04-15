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
});
