/**
 * The canary vault check (L6-03): the 10-minute health cron wakes ONE staff-owned
 * vault's Durable Object the way a client does (a read-only vault JWT, REST
 * note read + MCP `tools/list`, through the vault worker) and a failure goes to
 * the cron's own alert path. Plus POST /ops/canary-token, which lets an
 * external checker (scripts/uptime-check.sh) do the same from outside
 * Cloudflare.
 *
 * Real D1, real mint, real alert path (sender + ops_alerts dedupe). The vault
 * worker is the one system faked here: it answers as a healthy vault does, or
 * as a DO that failed to boot does (the 500 vault-do.ts handleFetch returns
 * while `bootError` is set). The vault side of the same probe runs against a
 * REAL vault DO in workers/vault/test/canary.test.ts.
 */
import { env } from "cloudflare:test";
import { afterEach, describe, expect, test, vi } from "vitest";
import app from "../src/index.ts";
import type { EmailSender, OpsEmail, SendResult } from "../src/email.ts";
import { runHealthCheck } from "../src/ops.ts";
import { decodeJwtPayload, seedUser, seedVault } from "./helpers.ts";

const T0 = new Date("2026-11-08T12:00:00.000Z");
let seq = 0;
const unique = (p: string) => `${p}${Date.now().toString(36)}${seq++}`;

function opsSender(): EmailSender & { sent: OpsEmail[] } {
  const sent: OpsEmail[] = [];
  return {
    kind: "devlog",
    sent,
    async sendMagicLink(): Promise<SendResult> {
      return { ok: true };
    },
    async sendOps(msg: OpsEmail): Promise<SendResult> {
      sent.push(msg);
      return { ok: true };
    },
    async sendDrip(): Promise<SendResult> {
      return { ok: true };
    },
  };
}

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

/** The 500 a vault DO answers every request with once its constructor failed (vault-do.ts handleFetch). */
const bootFailed = () =>
  json({ error: "Internal server error", detail: "NewerSchemaError: vault schema 19 is newer than this engine (18)" }, 500);

interface FakeVault {
  note?: () => Response;
  mcp?: () => Response;
}

/** A vault worker on VAULT_ORIGIN: /health is the router (always fine), /vault/<name>/... reaches the DO. */
function fakeVaultWorker(script: FakeVault = {}) {
  const calls: Array<{ path: string; method: string; auth: string; accept: string; body: string }> = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const path = new URL(req.url).pathname;
    if (path === "/health") return json({ status: "ok" });
    calls.push({
      path,
      method: req.method,
      auth: req.headers.get("authorization") ?? "",
      accept: req.headers.get("accept") ?? "",
      body: req.method === "POST" ? await req.text() : "",
    });
    if (/^\/vault\/[^/]+\/api\/notes\/[^/]+$/.test(path) && req.method === "GET") {
      return script.note ? script.note() : json({ id: "n1", path: "canary", content: "canary", tags: [] });
    }
    if (/^\/vault\/[^/]+\/mcp$/.test(path) && req.method === "POST") {
      return script.mcp
        ? script.mcp()
        : json({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "query-notes" }, { name: "find-path" }] } });
    }
    return json({ error: "Not found" }, 404);
  }) as typeof fetch;
  return { calls, fetchFn };
}

/** An operator-owned canary vault in D1, and the env that names it. */
async function canaryEnv(opts: { operator?: boolean } = {}) {
  const user = await seedUser(`${unique("staff")}@example.com`);
  if (opts.operator !== false) {
    await env.DB.prepare("UPDATE users SET role = 'operator' WHERE id = ?").bind(user.id).run();
  }
  const name = unique("canary");
  await seedVault(name, user.id);
  return { name, ownerId: user.id, env: { ...env, CANARY_VAULT_NAME: name } };
}

function captureLogs() {
  const logs: string[] = [];
  const errors: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  const err = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a.join(" ")));
  return {
    logs,
    errors,
    restore() {
      log.mockRestore();
      err.mockRestore();
    },
  };
}

let captured: ReturnType<typeof captureLogs> | null = null;
afterEach(() => {
  captured?.restore();
  captured = null;
});

describe("the health cron's canary vault check", () => {
  test("a healthy canary vault passes: one note read and one MCP tools/list, with a read-only token for that vault only", async () => {
    const c = await canaryEnv();
    const vault = fakeVaultWorker();
    const sender = opsSender();
    captured = captureLogs();
    const r = await runHealthCheck(c.env, sender, { now: () => T0, fetchFn: vault.fetchFn });

    expect(r.failures).toEqual([]);
    expect(sender.sent).toEqual([]);
    expect(vault.calls.map((x) => `${x.method} ${x.path}`)).toEqual([
      `GET /vault/${c.name}/api/notes/canary`,
      `POST /vault/${c.name}/mcp`,
    ]);
    // MCP Streamable HTTP needs both media types, and the call is a plain tools/list.
    expect(vault.calls[1]!.accept).toContain("application/json");
    expect(vault.calls[1]!.accept).toContain("text/event-stream");
    expect(JSON.parse(vault.calls[1]!.body)).toMatchObject({ jsonrpc: "2.0", method: "tools/list" });
    // The credential is what a client holds, and no more: read, this vault, not first-party.
    for (const call of vault.calls) {
      const claims = decodeJwtPayload(call.auth.replace(/^Bearer /, ""));
      expect(claims.scope).toBe(`vault:${c.name}:read`);
      expect(claims.aud).toBe(`vault.${c.name}`);
      expect(claims.vault_scope).toEqual([c.name]);
      expect(claims.sub).toBe(c.ownerId);
      expect(claims.client_id).toBe("parachute-canary");
      expect((claims.exp as number) - (claims.iat as number)).toBeLessThanOrEqual(60);
    }
  });

  test("a canary DO that fails to boot (every request 500s) is a health failure that alerts, with the reason", async () => {
    const c = await canaryEnv();
    const vault = fakeVaultWorker({ note: bootFailed, mcp: bootFailed });
    const sender = opsSender();
    captured = captureLogs();
    const r = await runHealthCheck(c.env, sender, { now: () => T0, fetchFn: vault.fetchFn });

    expect(r.failures.map((f) => f.check)).toEqual(["vault-canary"]);
    const detail = r.failures[0]!.detail;
    expect(detail).toContain("note read");
    expect(detail).toContain("HTTP 500");
    expect(detail).toContain("NewerSchemaError");
    // The cron's own alert path: one email, deduped under health:vault-canary.
    expect(r.alerted.map((f) => f.check)).toEqual(["vault-canary"]);
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]!.subject).toContain("vault-canary");
    expect(sender.sent[0]!.text).toContain("HTTP 500");
    expect(captured.errors.some((l) => l.includes("event=health_check_failed check=vault-canary"))).toBe(true);
    const dedupe = await env.DB.prepare("SELECT key FROM ops_alerts WHERE key = 'health:vault-canary'").first();
    expect(dedupe).not.toBeNull();
  });

  test("a 5xx on MCP tools/list alone (the note read is fine) still fails the check", async () => {
    const c = await canaryEnv();
    const vault = fakeVaultWorker({ mcp: () => json({ error: "Internal server error" }, 503) });
    captured = captureLogs();
    const r = await runHealthCheck(c.env, opsSender(), { now: () => T0, fetchFn: vault.fetchFn });
    expect(r.failures.map((f) => f.check)).toEqual(["vault-canary"]);
    expect(r.failures[0]!.detail).toContain("mcp tools/list");
    expect(r.failures[0]!.detail).toContain("HTTP 503");
  });

  test("a canary vault not owned by an operator account is refused before any read", async () => {
    const c = await canaryEnv({ operator: false });
    const vault = fakeVaultWorker();
    captured = captureLogs();
    const r = await runHealthCheck(c.env, opsSender(), { now: () => T0, fetchFn: vault.fetchFn });
    expect(r.failures.map((f) => f.check)).toEqual(["vault-canary"]);
    expect(r.failures[0]!.detail).toContain("operator");
    expect(vault.calls).toEqual([]);
  });

  test("no canary configured: skipped with one log line, no vault call, no failure, no alert", async () => {
    const vault = fakeVaultWorker();
    const sender = opsSender();
    captured = captureLogs();
    const r = await runHealthCheck({ ...env, CANARY_VAULT_NAME: "  " }, sender, { now: () => T0, fetchFn: vault.fetchFn });
    expect(r.failures).toEqual([]);
    expect(r.alerted).toEqual([]);
    expect(sender.sent).toEqual([]);
    expect(vault.calls).toEqual([]);
    expect(captured.logs.filter((l) => l.includes("canary"))).toEqual(["event=health_canary_skipped reason=not_configured"]);
    expect(captured.errors.filter((l) => l.includes("canary"))).toEqual([]);
  });
});

describe("POST /ops/canary-token (the external checker's credential)", () => {
  const SECRET = "ops-canary-test-token";
  const post = (e: Record<string, unknown>, auth?: string) =>
    app.fetch(
      new Request(`${env.ISSUER}/ops/canary-token`, { method: "POST", headers: auth ? { authorization: `Bearer ${auth}` } : {} }),
      e as unknown as typeof env,
    );

  test("unset secret → 404; wrong or missing bearer → 401", async () => {
    const c = await canaryEnv();
    expect((await post(c.env, SECRET)).status).toBe(404);
    expect((await post({ ...c.env, OPS_CANARY_TOKEN: SECRET })).status).toBe(401);
    expect((await post({ ...c.env, OPS_CANARY_TOKEN: SECRET }, "wrong")).status).toBe(401);
  });

  test("mints a short read-only token for the configured canary vault only, plus where to spend it", async () => {
    const c = await canaryEnv();
    const res = await post({ ...c.env, OPS_CANARY_TOKEN: SECRET }, SECRET);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { vault_token: string; expires_in: number; vault_url: string; note: string };
    expect(body.vault_url).toBe(`${env.VAULT_ORIGIN!.replace(/\/$/, "")}/vault/${c.name}`);
    expect(body.note).toBe("canary");
    expect(body.expires_in).toBeLessThanOrEqual(300);
    const claims = decodeJwtPayload(body.vault_token);
    expect(claims.scope).toBe(`vault:${c.name}:read`);
    expect(claims.aud).toBe(`vault.${c.name}`);
    expect(claims.client_id).toBe("parachute-canary");
  });

  test("not configured → 404 canary_not_configured; not operator-owned → 409, no token", async () => {
    const none = await post({ ...env, CANARY_VAULT_NAME: "", OPS_CANARY_TOKEN: SECRET }, SECRET);
    expect(none.status).toBe(404);
    expect(((await none.json()) as { error: string }).error).toBe("canary_not_configured");
    const c = await canaryEnv({ operator: false });
    const refused = await post({ ...c.env, OPS_CANARY_TOKEN: SECRET }, SECRET);
    expect(refused.status).toBe(409);
    expect(JSON.stringify(await refused.json())).not.toContain("vault_token");
  });
});
