/**
 * Smoke tests for parachute-cloud v0.4 (user-per-subdomain).
 *
 * Runs against a live `wrangler dev` instance:
 *   1. `bun install`
 *   2. `cp .dev.vars.example .dev.vars`
 *   3. `wrangler d1 migrations apply parachute-cloud-accounts --local`
 *   4. `wrangler dev` in another shell
 *   5. `bun test tests/smoke.test.ts`
 *
 * Each test allocates its own dev user (since one user → one hostname).
 */

import { describe, it, expect } from "bun:test";

const BASE = process.env.CLOUD_BASE_URL ?? "http://127.0.0.1:8787";

const isLocal =
  BASE.includes("127.0.0.1") ||
  BASE.includes("localhost") ||
  process.env.CLOUD_ENV === "development";

/** Call a root-domain route as a synthesized dev user. */
async function asUser(
  devUser: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (isLocal) headers.set("X-Dev-User", devUser);
  return fetch(`${BASE}${path}`, { ...init, headers });
}

/**
 * Per-user cookie jar: we need to persist the `pcs_csrf` cookie across a
 * GET/POST pair, and the `pcr` reveal cookie from a POST into the following
 * GET that actually surfaces the token in HTML.
 *
 * Deliberately tiny — we just track name→value, no attribute parsing.
 */
function newJar(): {
  read: () => string;
  absorb: (res: Response) => void;
} {
  const store = new Map<string, string>();
  return {
    read: () =>
      [...store.entries()].map(([k, v]) => `${k}=${v}`).join("; "),
    absorb: (res: Response) => {
      // Bun/undici: use getSetCookie() to grab all Set-Cookie lines.
      const lines = (res.headers as unknown as {
        getSetCookie?: () => string[];
      }).getSetCookie?.() ?? [];
      for (const line of lines) {
        const [pair] = line.split(";");
        if (!pair) continue;
        const eq = pair.indexOf("=");
        if (eq === -1) continue;
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        if (value === "" || name === "") store.delete(name);
        else store.set(name, value);
      }
    },
  };
}

/**
 * GET /dashboard (or /onboarding/choose-hostname) to pick up the CSRF
 * cookie, then POST the form with the matching `csrf` field injected. The
 * jar absorbs any Set-Cookie lines along the way so the same caller can
 * chain follow-up GETs and read the reveal cookie.
 */
async function csrfPost(
  devUser: string,
  jar: ReturnType<typeof newJar>,
  path: string,
  fields: Record<string, string>,
  primePath = "/dashboard",
): Promise<Response> {
  // Prime the jar + learn the token if we don't have one yet.
  if (!jar.read().includes("pcs_csrf=")) {
    const primed = await asUser(devUser, primePath, {
      headers: { Cookie: jar.read() },
      redirect: "manual",
    });
    jar.absorb(primed);
  }
  const token = /pcs_csrf=([a-f0-9-]{36})/.exec(jar.read())?.[1];
  if (!token) throw new Error("csrf cookie never set by prime request");
  const body = new URLSearchParams({ ...fields, csrf: token });
  const res = await asUser(devUser, path, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: jar.read(),
    },
    body: body.toString(),
    redirect: "manual",
  });
  jar.absorb(res);
  return res;
}

/** Fetch /dashboard, read the reveal banner, return the raw pvt_ token. */
async function readRevealedToken(
  devUser: string,
  jar: ReturnType<typeof newJar>,
): Promise<string> {
  const res = await asUser(devUser, "/dashboard", {
    headers: { Cookie: jar.read() },
  });
  jar.absorb(res);
  const html = await res.text();
  const m = /class="token-reveal">\s*(pvt_[A-Za-z0-9_-]+)\s*</.exec(html);
  if (!m) throw new Error("no token-reveal banner found on /dashboard");
  return m[1]!;
}

/** Hit a user subdomain by Host header. `wrangler dev` serves any host. */
async function onHost(
  hostname: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Host", hostname);
  return fetch(`${BASE}${path}`, { ...init, headers });
}

function uniq(prefix: string): { devUser: string; sub: string } {
  const tag = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const sub = `${prefix}${tag}`.toLowerCase().slice(0, 30);
  return { devUser: `u-${tag}:${tag}@dev.local`, sub };
}

async function signup(devUser: string, subdomain: string) {
  const res = await asUser(devUser, "/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subdomain }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as {
    hostname: string;
    vaultId: string;
    vaultSlug: string;
    vaultUrl: string;
    mcpUrl: string;
    apiToken: string;
  };
}

describe("parachute-cloud v0.4 smoke", () => {
  it("health probe returns structured check shape", async () => {
    const res = await fetch(`${BASE}/health`);
    expect([200, 503]).toContain(res.status);
    const json = (await res.json()) as {
      ok: boolean;
      service: string;
      version: string;
      checks: { d1: boolean; r2: boolean };
    };
    expect(json.service).toBe("parachute-cloud");
    expect(typeof json.version).toBe("string");
  });

  it("check-hostname: available vs reserved", async () => {
    const r1 = await fetch(`${BASE}/api/check-hostname?name=www`);
    const j1 = (await r1.json()) as { available: boolean; reason?: string };
    expect(j1.available).toBe(false);

    const r2 = await fetch(`${BASE}/api/check-hostname?name=${uniq("fresh").sub}`);
    const j2 = (await r2.json()) as { available: boolean };
    expect(j2.available).toBe(true);
  });

  it("signup provisions hostname + default vault + user-scope token; token round-trips /v/default/api/*", async () => {
    const { devUser, sub } = uniq("sig");
    const s = await signup(devUser, sub);

    expect(s.hostname).toBe(`${sub}.parachute.computer`);
    expect(s.vaultSlug).toBe("default");
    expect(s.apiToken).toMatch(/^pvt_/);
    expect(s.vaultUrl).toContain("/v/default");
    expect(s.mcpUrl).toContain("/v/default/mcp");

    // No token → 401.
    const unauth = await onHost(s.hostname, "/v/default/api/notes");
    expect(unauth.status).toBe(401);

    const list = await onHost(s.hostname, "/v/default/api/notes", {
      headers: { Authorization: `Bearer ${s.apiToken}` },
    });
    expect(list.status).toBe(200);

    const create = await onHost(s.hostname, "/v/default/api/notes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${s.apiToken}`,
      },
      body: JSON.stringify({ content: "hello v0.4" }),
    });
    expect(create.status).toBe(201);
  });

  it("one user = one hostname: second signup for same user rejects", async () => {
    const { devUser, sub } = uniq("once");
    await signup(devUser, sub);
    const { sub: sub2 } = uniq("twice");
    const res = await asUser(devUser, "/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subdomain: sub2 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("already_onboarded");
  });

  it("user-scope token works across multiple vaults the user creates", async () => {
    const { devUser, sub } = uniq("multi");
    const s = await signup(devUser, sub);

    // Create a second vault via the dashboard (CSRF-guarded).
    const jar = newJar();
    const add = await csrfPost(devUser, jar, "/dashboard/vaults", {
      name: "Work",
      slug: "work",
    });
    expect([302, 303]).toContain(add.status);

    // Same user-scope token should work on both /v/default and /v/work.
    const onDefault = await onHost(s.hostname, "/v/default/api/notes", {
      headers: { Authorization: `Bearer ${s.apiToken}` },
    });
    expect(onDefault.status).toBe(200);
    const onWork = await onHost(s.hostname, "/v/work/api/notes", {
      headers: { Authorization: `Bearer ${s.apiToken}` },
    });
    expect(onWork.status).toBe(200);
  });

  it("vault-scope token only works on its own slug", async () => {
    const { devUser, sub } = uniq("scope");
    const s = await signup(devUser, sub);

    const jar = newJar();
    // Create a second vault.
    await csrfPost(devUser, jar, "/dashboard/vaults", {
      name: "Work",
      slug: "work",
    });

    // Issue a vault-scoped token for /v/work.
    const issued = await csrfPost(devUser, jar, "/dashboard/tokens", {
      name: "work-only",
      scope: "vault",
      vault_slug: "work",
    });
    expect([302, 303]).toContain(issued.status);
    // Token reveal now rides a `pcr` HttpOnly cookie + /dashboard render.
    const vaultToken = await readRevealedToken(devUser, jar);
    expect(vaultToken).toMatch(/^pvt_/);

    // Works on /v/work.
    const ok = await onHost(s.hostname, "/v/work/api/notes", {
      headers: { Authorization: `Bearer ${vaultToken}` },
    });
    expect(ok.status).toBe(200);

    // Rejected on /v/default.
    const nope = await onHost(s.hostname, "/v/default/api/notes", {
      headers: { Authorization: `Bearer ${vaultToken}` },
    });
    expect(nope.status).toBe(401);
  });

  it("revoked token gets 401", async () => {
    const { devUser, sub } = uniq("rev");
    const s = await signup(devUser, sub);

    const jar = newJar();
    // Issue a fresh token to revoke.
    const issued = await csrfPost(devUser, jar, "/dashboard/tokens", {
      name: "throwaway",
      scope: "user",
    });
    expect([302, 303]).toContain(issued.status);
    const throwaway = await readRevealedToken(devUser, jar);

    // List tokens on dashboard to find the id for "throwaway". Note: the
    // readRevealedToken call above also re-fetched /dashboard, so we re-GET
    // here without relying on that previous body.
    const page = await asUser(devUser, "/dashboard", {
      headers: { Cookie: jar.read() },
    });
    const html = await page.text();
    const rowRe = /\/dashboard\/tokens\/([a-f0-9-]{36})\/revoke/g;
    const ids = [...html.matchAll(rowRe)].map((m) => m[1]);
    // Newest issued token is first on the page (ORDER BY created_at DESC).
    const id = ids[0];
    expect(id).toBeTruthy();

    // Revoke it (CSRF-guarded like every dashboard POST).
    const revoke = await csrfPost(devUser, jar, `/dashboard/tokens/${id}/revoke`, {});
    expect([302, 303]).toContain(revoke.status);

    // Throwaway no longer works.
    const after = await onHost(s.hostname, "/v/default/api/notes", {
      headers: { Authorization: `Bearer ${throwaway}` },
    });
    expect(after.status).toBe(401);

    // Original default token still works.
    const still = await onHost(s.hostname, "/v/default/api/notes", {
      headers: { Authorization: `Bearer ${s.apiToken}` },
    });
    expect(still.status).toBe(200);
  });

  it("attachment upload + download force octet-stream", async () => {
    const { devUser, sub } = uniq("att");
    const s = await signup(devUser, sub);

    const noteRes = await onHost(s.hostname, "/v/default/api/notes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${s.apiToken}`,
      },
      body: JSON.stringify({ content: "note with attachment" }),
    });
    expect(noteRes.status).toBe(201);
    const { note } = (await noteRes.json()) as { note: { id: string } };

    const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const form = new FormData();
    form.append("file", new Blob([payload], { type: "application/octet-stream" }), "x.bin");

    const up = await onHost(s.hostname, `/v/default/api/notes/${note.id}/attachments`, {
      method: "POST",
      headers: { Authorization: `Bearer ${s.apiToken}` },
      body: form,
    });
    expect(up.status).toBe(201);
    const { attachment } = (await up.json()) as { attachment: { id: string } };

    const down = await onHost(
      s.hostname,
      `/v/default/api/notes/${note.id}/attachments/${attachment.id}`,
      { headers: { Authorization: `Bearer ${s.apiToken}` } },
    );
    expect(down.status).toBe(200);
    expect(down.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(down.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("cross-user: another user's token cannot reach this user's vault", async () => {
    const a = uniq("a");
    const b = uniq("b");
    const sa = await signup(a.devUser, a.sub);
    const sb = await signup(b.devUser, b.sub);

    // B's token on A's hostname → 401 (user mismatch).
    const cross = await onHost(sa.hostname, "/v/default/api/notes", {
      headers: { Authorization: `Bearer ${sb.apiToken}` },
    });
    expect(cross.status).toBe(401);
  });
});
