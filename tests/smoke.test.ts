/**
 * Smoke tests for parachute-cloud.
 *
 * Runs against a live `wrangler dev` instance (cheaper than vitest-pool-workers).
 * Before running: `bun install && wrangler d1 migrations apply accounts --local`,
 * then `wrangler dev` in another shell, then `bun test tests/smoke.test.ts`.
 *
 * Aaron can skip these in CI until we wire a proper dev harness. The point is
 * to prove the wiring end-to-end: signup → dashboard → vault DO → round-trip.
 */

import { describe, it, expect } from "bun:test";

const BASE = process.env.CLOUD_BASE_URL ?? "http://127.0.0.1:8787";
const DEV_USER = "X-Dev-User: smoke-user:smoke@dev.local";

async function dev(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const [name, val] = DEV_USER.split(": ");
  if (name && val) headers.set(name, val);
  return fetch(`${BASE}${path}`, { ...init, headers });
}

describe("parachute-cloud smoke", () => {
  it("dispatcher health responds", async () => {
    const res = await fetch(`${BASE}/health`);
    expect(res.status).toBe(200);
    const json = await res.json() as { ok: boolean };
    expect(json.ok).toBe(true);
  });

  it("signup provisions a vault and the subdomain round-trips through the DO", async () => {
    const name = `smoke${Date.now().toString(36)}`;
    const signup = await dev("/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    expect(signup.status).toBe(201);
    const { hostname } = (await signup.json()) as { hostname: string };
    expect(hostname).toBe(`${name}.parachute.computer`);

    const list = await fetch(`${BASE}/api/notes`, {
      headers: { Host: hostname },
    });
    expect(list.status).toBe(200);
    const { notes } = (await list.json()) as { notes: unknown[] };
    expect(Array.isArray(notes)).toBe(true);

    const create = await fetch(`${BASE}/api/notes`, {
      method: "POST",
      headers: { Host: hostname, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hello from smoke" }),
    });
    expect(create.status).toBe(201);
    const { note } = (await create.json()) as { note: { id: string; content: string } };
    expect(note.content).toBe("hello from smoke");
  });
});
