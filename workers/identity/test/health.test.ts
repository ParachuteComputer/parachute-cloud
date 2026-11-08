/**
 * The health report and its counters (T-411): health-counters.ts (recording,
 * collection, the rollup copy) and health-report.ts (the rules). Pinned:
 *   - the rules: a planted failure on one vault is caught, a healthy vault
 *     stays quiet, a client-error storm counts only against a real baseline,
 *     "stopped working", "still failing", and the since-deploy window;
 *   - the token endpoint counts grants per connector CLASS, never the
 *     client's own name;
 *   - the nightly rollup copies the vault's counters (idempotently) under its
 *     opaque id, and the report shows only a hash of that;
 *   - the daily line carries "worse N" and raises an alert when N > 0;
 *   - the doors: /ops/health needs the read bearer, the staging hooks 404
 *     off staging.
 */
import { createExecutionContext, env, fetchMock, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import worker from "../src/index.ts";
import { buildHealthReport, outcomeClass, type HealthRow } from "../src/health-report.ts";
import { connectorClass, identityRouteGroup, loadHealthRows, parseVaultHealth } from "../src/health-counters.ts";
import { runUsageRollup } from "../src/usage.ts";
import { runDailyLine } from "../src/ops-daily.ts";
import type { EmailSender, OpsEmail, SendResult } from "../src/email.ts";
import type { Env } from "../src/env.ts";
import { planEntitlement } from "../src/plans.ts";
import { ISSUER, REDIRECT_URI, deps, makePkce, seedApprovedClient, seedUser, seedVault, tokenReq } from "./helpers.ts";
import { issueAuthCode } from "../src/auth-codes.ts";

const DAY = "2026-11-07";
const PRIOR = "2026-11-06";

function row(p: Partial<HealthRow> & { subject: string; outcome: string; n: number }): HealthRow {
  return { day: DAY, source: "vault", version: "unversioned", vault: "vault-id-a", ...p };
}

/** A normal day of traffic on one vault. */
function normalDay(vault: string, day: string, version = "unversioned"): HealthRow[] {
  return [
    row({ vault, day, version, subject: "http:notes", outcome: "2xx", n: 120 }),
    row({ vault, day, version, subject: "http:mcp", outcome: "2xx", n: 60 }),
    row({ vault, day, version, subject: "http:mcp", outcome: "4xx:401", n: 3 }),
    row({ vault, day, version, subject: "mcp:query-notes", outcome: "ok", n: 40 }),
    row({ vault, day, version, subject: "mcp:query-notes", outcome: "tool_error", n: 2 }),
  ];
}

function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  return fn().finally(() => {
    err.mockRestore();
    log.mockRestore();
  });
}

describe("the report rules", () => {
  test("a planted 500 on one vault is caught; the other vault, same traffic, stays quiet", async () => {
    const rows = [
      ...normalDay("vault-id-a", PRIOR),
      ...normalDay("vault-id-b", PRIOR),
      ...normalDay("vault-id-a", DAY),
      ...normalDay("vault-id-b", DAY),
      row({ vault: "vault-id-a", subject: "http:notes", outcome: "5xx:500", n: 5 }),
    ];
    const r = await buildHealthReport(rows, { day: DAY, environment: "production" });
    expect(r.worse).toHaveLength(1);
    expect(r.worse[0]).toMatchObject({ window: "day", subject: "http:notes", kind: "new_server_errors" });
    expect(r.worse[0]!.who).toMatch(/^v:[0-9a-f]{8}$/);
    expect(r.text).toContain("1 worse");
    expect(r.text).toContain("5xx:500 ×5");
    // Never the vault's id (let alone a name) in what the operator reads.
    expect(JSON.stringify(r)).not.toContain("vault-id-a");
  });

  test("two normal days: nothing worse", async () => {
    const rows = [...normalDay("vault-id-a", PRIOR), ...normalDay("vault-id-a", DAY)];
    const r = await buildHealthReport(rows, { day: DAY, environment: "production" });
    expect(r.worse).toEqual([]);
    expect(r.stillFailing).toEqual([]);
    expect(r.text.split("\n")[0]).toBe(`parachute-cloud health ${DAY} (vs ${PRIOR}): nothing worse`);
  });

  test("a 401 storm counts against a real baseline, and not without one", async () => {
    const storm = row({ vault: "vault-id-a", subject: "http:mcp", outcome: "4xx:401", n: 50 });
    const withBase = await buildHealthReport([...normalDay("vault-id-a", PRIOR), ...normalDay("vault-id-a", DAY), storm], {
      day: DAY,
      environment: "production",
    });
    expect(withBase.worse.map((f) => f.kind)).toContain("client_reason_up");
    // A fresh vault: no day before, so 401s from a first connect are normal.
    const fresh = await buildHealthReport([storm, row({ vault: "vault-id-a", subject: "http:mcp", outcome: "2xx", n: 3 })], {
      day: DAY,
      environment: "production",
    });
    expect(fresh.worse).toEqual([]);
  });

  test("a tool that worked yesterday and only fails today has stopped working", async () => {
    const rows = [
      row({ day: PRIOR, subject: "mcp:create-note", outcome: "ok", n: 9 }),
      row({ subject: "mcp:create-note", outcome: "tool_error", n: 6 }),
    ];
    const r = await buildHealthReport(rows, { day: DAY, environment: "production" });
    expect(r.worse.map((f) => f.kind)).toEqual(["stopped_working"]);
  });

  test("server errors at the same low rate both days are still failing, not worse", async () => {
    const rows = [
      ...normalDay("vault-id-a", PRIOR),
      row({ day: PRIOR, subject: "http:notes", outcome: "5xx:500", n: 2 }),
      ...normalDay("vault-id-a", DAY),
      row({ subject: "http:notes", outcome: "5xx:500", n: 2 }),
    ];
    const r = await buildHealthReport(rows, { day: DAY, environment: "production" });
    expect(r.worse).toEqual([]);
    expect(r.stillFailing).toHaveLength(1);
  });

  test("since the deploy: the newest version against the one before it", async () => {
    const old = "2026-11-05t10:00:00z~aaaaaaaa";
    const cur = "2026-11-07t09:00:00z~bbbbbbbb";
    const rows = [
      ...normalDay("vault-id-a", "2026-11-05", old),
      ...normalDay("vault-id-a", "2026-11-06", old),
      // The deploy landed mid-morning on DAY: the day already mixes both.
      ...normalDay("vault-id-a", DAY, old),
      row({ version: cur, subject: "http:notes", outcome: "2xx", n: 30 }),
      row({ version: cur, subject: "do", outcome: "cpu_limit", n: 4 }),
    ];
    const r = await buildHealthReport(rows, { day: DAY, environment: "production" });
    expect(r.windows.deploy.map((w) => [w.before, w.after])).toEqual([[old, cur]]);
    const kinds = r.worse.map((f) => `${f.window}:${f.subject}:${f.kind}`);
    expect(kinds).toContain("day:do:new_server_errors");
    // The same finding is not repeated for the deploy window.
    expect(kinds.filter((k) => k.includes("do:new_server_errors"))).toHaveLength(1);
  });

  test("outcome classes", () => {
    expect(outcomeClass("2xx")).toBe("ok");
    expect(outcomeClass("ok")).toBe("ok");
    expect(outcomeClass("5xx:503")).toBe("server");
    expect(outcomeClass("exception:typeerror")).toBe("server");
    expect(outcomeClass("cpu_limit")).toBe("server");
    expect(outcomeClass("fail")).toBe("server");
    expect(outcomeClass("code_updated")).toBe("client");
    expect(outcomeClass("invalid_grant")).toBe("client");
  });
});

describe("what gets counted, and as what", () => {
  test("connector classes come from the registered redirect hosts, never the client's name", () => {
    expect(connectorClass("abc", ["https://claude.ai/api/mcp/auth_callback"])).toBe("claude");
    expect(connectorClass("abc", ["https://chatgpt.com/connector_platform_oauth_redirect"])).toBe("chatgpt");
    expect(connectorClass("abc", ["http://localhost:8976/callback"])).toBe("local");
    expect(connectorClass("abc", ["https://evil.example/cb"])).toBe("other");
    expect(connectorClass("parachute-console", null)).toBe("parachute");
    expect(identityRouteGroup("/oauth/token")).toBe("oauth");
    expect(identityRouteGroup("/health")).toBeNull();
    expect(identityRouteGroup("/anything-a-caller-types")).toBe("other");
  });

  test("a vault's block is validated: odd shapes dropped, strings cleaned", () => {
    const rows = parseVaultHealth(
      {
        days: {
          [DAY]: { v1: { "http:notes|2xx": 3, "bad-no-bar": 1, "x|y": -1, "Mixed Case|Ok": 2 } },
          "not-a-day": { v1: { "a|b": 1 } },
        },
      },
      "vid",
    )!;
    expect(rows.map((r) => `${r.subject}|${r.outcome}=${r.n}`).sort()).toEqual(["http:notes|2xx=3", "mixed_case|ok=2"]);
    expect(parseVaultHealth(undefined, "vid")).toBeNull();
  });

  test("the token endpoint counts a refresh per connector class, after the response", async () => {
    const { id: user } = await seedUser("health-oauth@example.com");
    await seedVault("hoauth", user);
    const { clientId } = await seedApprovedClient({
      redirectUris: [REDIRECT_URI, "https://claude.ai/api/mcp/auth_callback"],
      clientName: "Zq7 Private Client Name",
    });
    const { verifier, challenge } = await makePkce();
    const code = await issueAuthCode(env.DB, {
      clientId,
      userId: user,
      redirectUri: REDIRECT_URI,
      scopes: ["vault:hoauth:read"],
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
    });
    const run = async (req: Request) => {
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, env, ctx);
      await waitOnExecutionContext(ctx);
      return res;
    };
    const first = await run(
      tokenReq({ grant_type: "authorization_code", code: code.code, client_id: clientId, redirect_uri: REDIRECT_URI, code_verifier: verifier }),
    );
    expect(first.status).toBe(200);
    const pair = (await first.json()) as { refresh_token: string };
    expect((await run(tokenReq({ grant_type: "refresh_token", refresh_token: pair.refresh_token, client_id: clientId }))).status).toBe(200);
    expect((await run(tokenReq({ grant_type: "refresh_token", refresh_token: "not-a-real-token", client_id: clientId }))).status).toBe(400);

    const today = new Date().toISOString().slice(0, 10);
    const rows = await loadHealthRows(env.DB, today, today);
    const got = Object.fromEntries(rows.filter((r) => r.subject.startsWith("oauth:")).map((r) => [`${r.subject}|${r.outcome}`, r.n]));
    expect(got).toEqual({ "oauth:code:claude|ok": 1, "oauth:refresh:claude|ok": 1, "oauth:refresh:claude|invalid_grant": 1 });
    expect(rows.find((r) => r.subject === "http:oauth" && r.outcome === "2xx")?.n).toBe(2);
    expect(JSON.stringify(rows)).not.toContain("Zq7");
  });
});

describe("collection and the daily line", () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });
  afterEach(() => fetchMock.assertNoPendingInterceptors());

  function interceptConfig(vault: string, health: unknown): void {
    const ent = planEntitlement("trial");
    fetchMock
      .get(env.VAULT_ORIGIN!)
      .intercept({ path: `/vault/${vault}/api/internal/config`, method: "GET" })
      .reply(
        200,
        {
          caps: ent.caps,
          frozen: ent.frozen,
          transcription_enabled: ent.transcription.enabled,
          transcribe_minutes_limit: ent.transcription.minutes_limit,
          db_bytes: 10,
          r2_bytes: 0,
          health,
        },
        { headers: { "content-type": "application/json" } },
      );
  }

  test("the nightly rollup copies each vault's counters under its opaque id, idempotently", async () => {
    const { id: owner } = await seedUser("health-roll@example.com");
    await seedVault("hroll-zq7name", owner);
    const block = { version: "v1", days: { [DAY]: { v1: { "http:notes|2xx": 7, "http:notes|5xx:500": 2 } } } };
    interceptConfig("hroll-zq7name", block);
    interceptConfig("hroll-zq7name", block);
    const now = new Date();
    const d = { ...deps(() => now), vaultOrigin: env.VAULT_ORIGIN };
    await quietly(() => runUsageRollup(env, d, { onlyVault: "hroll-zq7name" }));
    await quietly(() => runUsageRollup(env, d, { onlyVault: "hroll-zq7name" }));
    const vid = (await env.DB.prepare("SELECT vault_id FROM vaults WHERE name = ?").bind("hroll-zq7name").first<{ vault_id: string }>())!
      .vault_id;
    const rows = (await loadHealthRows(env.DB, DAY, DAY)).filter((r) => r.vault === vid);
    expect(rows.map((r) => `${r.subject}|${r.outcome}=${r.n}`).sort()).toEqual(["http:notes|2xx=7", "http:notes|5xx:500=2"]);
    const r = await buildHealthReport(rows, { day: DAY, environment: "production" });
    expect(JSON.stringify(r)).not.toContain("zq7name");
    expect(JSON.stringify(r)).not.toContain(vid);
  });

  test("the daily line says how many things got worse, and alerts when that is not 0", async () => {
    const sent: OpsEmail[] = [];
    const sender: EmailSender = {
      kind: "devlog",
      async sendMagicLink(): Promise<SendResult> {
        return { ok: true };
      },
      async sendOps(m: OpsEmail): Promise<SendResult> {
        sent.push(m);
        return { ok: true };
      },
      async sendDrip(): Promise<SendResult> {
        return { ok: true };
      },
    };
    const stmt = env.DB.prepare(
      "INSERT INTO health_counters (day, source, version, vault, subject, outcome, n) VALUES (?, 'vault', 'unversioned', 'hd-vault', ?, ?, ?)",
    );
    await env.DB.batch([
      stmt.bind(PRIOR, "http:notes", "2xx", 50),
      stmt.bind(DAY, "http:notes", "2xx", 50),
      stmt.bind(DAY, "http:export", "5xx:500", 3),
    ]);
    const e: Env = { ...env, OPERATOR_ALERT_EMAIL: "ops@example.com" };
    const r = await quietly(() => runDailyLine(e, sender, { now: new Date("2026-11-08T03:31:00Z"), day: DAY }));
    expect(r.line).toContain(" · worse 1");
    expect(sent.map((m) => m.subject)).toEqual([
      "[parachute-cloud test] daily — 2026-11-07",
      "[parachute-cloud test] 1 thing got worse for users (2026-11-07)",
    ]);
    expect(sent[1]!.text).toContain("http:export");
    expect(sent[0]!.text).toContain("WORSE");
  });
});

describe("the doors", () => {
  const get = (path: string, headers: Record<string, string> = {}, extra: Partial<Env> = {}) =>
    worker.fetch(new Request(`${ISSUER}${path}`, { headers }), { ...env, ...extra } as Env, createExecutionContext());

  beforeEach(() => {});

  test("/ops/health: 404 without the read secret configured, 401 with a wrong bearer, 200 with the right one", async () => {
    expect((await get("/ops/health", {}, { OPS_READ_TOKEN: undefined })).status).toBe(404);
    expect((await get("/ops/health", { authorization: "Bearer nope" }, { OPS_READ_TOKEN: "read-secret" })).status).toBe(401);
    const ok = await get(`/ops/health?day=${DAY}`, { authorization: "Bearer read-secret" }, { OPS_READ_TOKEN: "read-secret" });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { day: string; text: string };
    expect(body.day).toBe(DAY);
    expect(body.text).toContain("health");
  });

  test("the staging hooks 404 in production", async () => {
    expect((await get("/__test/health-report", {}, { ENVIRONMENT: "production" })).status).toBe(404);
    const post = await worker.fetch(
      new Request(`${ISSUER}/__test/health-collect?vault=x`, { method: "POST" }),
      { ...env, ENVIRONMENT: "production" } as Env,
      createExecutionContext(),
    );
    expect(post.status).toBe(404);
  });
});
