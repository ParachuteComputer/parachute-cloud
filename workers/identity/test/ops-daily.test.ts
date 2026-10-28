/**
 * Operating basics (T-318 ops): the daily ops line, the operator fan-out
 * (every recipient + one webhook), the 5xx counter + error-rate alert, and the
 * read endpoints. Real D1 throughout; the only fake is the outbound webhook
 * fetch (and the vault /health probe, which is outside this worker).
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, test, vi } from "vitest";
import worker from "../src/index.ts";
import type { EmailSender, OpsEmail, SendResult } from "../src/email.ts";
import type { Env } from "../src/env.ts";
import { USAGE_CRON, handleScheduled, runHealthCheck } from "../src/ops.ts";
import { operatorRecipients, raiseOpsAlert } from "../src/ops-alerts.ts";
import { opsBucket, sumOpsCounter } from "../src/ops-counters.ts";
import { collectDailyStats, renderDailyLine, runDailyLine } from "../src/ops-daily.ts";
import { createSession } from "../src/sessions.ts";
import { createUser } from "../src/users.ts";
import { CSRF, ISSUER, seedSession, seedUser } from "./helpers.ts";

const RECIPIENTS = "ops-a@example.com, ops-b@example.com";
const WEBHOOK = "https://hooks.example.com/ops-test";

/** The env an operator would configure: two recipients + a webhook. */
function opsEnv(extra: Partial<Env> = {}): Env {
  return { ...env, OPERATOR_ALERT_EMAIL: RECIPIENTS, OPS_ALERT_WEBHOOK_URL: WEBHOOK, ...extra };
}

function opsSender(result: SendResult = { ok: true }): EmailSender & { sent: OpsEmail[] } {
  const sent: OpsEmail[] = [];
  return {
    kind: "devlog",
    sent,
    async sendMagicLink(): Promise<SendResult> {
      return { ok: true };
    },
    async sendOps(msg: OpsEmail): Promise<SendResult> {
      sent.push(msg);
      return result;
    },
    async sendDrip(): Promise<SendResult> {
      return { ok: true };
    },
  };
}

/** The ONE fake: the outbound webhook POST. */
function fakeWebhook(behaviour: "ok" | "500" | "throw" = "ok") {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
    if (behaviour === "throw") throw new Error("connect timeout");
    return new Response("ok", { status: behaviour === "500" ? 500 : 200 });
  }) as typeof fetch;
  return { fn, calls };
}

function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  return fn().finally(() => {
    err.mockRestore();
    log.mockRestore();
  });
}

async function setCounter(bucket: string, name: string, count: number): Promise<void> {
  await env.DB.prepare("INSERT INTO ops_counters (bucket, name, count) VALUES (?, ?, ?)").bind(bucket, name, count).run();
}

async function seedUsage(vault: string, day: string, db: number, r2: number, minutes: number, notes: number | null) {
  await env.DB.prepare(
    "INSERT INTO vault_usage (vault_name, day, db_bytes, r2_bytes, transcribe_minutes, notes_changed_24h) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(vault, day, db, r2, minutes, notes)
    .run();
}

// The day under test and the 03:30 UTC run that closes it.
const DAY = "2026-10-27";
const RUN_AT = new Date("2026-10-28T03:30:00Z");

/** A realistic day: 4 live users (+3 that day), 1 pending deletion, 4 vaults, counters. */
async function seedDay(): Promise<void> {
  await createUser(env.DB, "old@example.com", "", new Date("2026-10-01T10:00:00Z"));
  for (const h of ["01", "12", "23"]) await createUser(env.DB, `new-${h}@example.com`, "", new Date(`${DAY}T${h}:00:00Z`));
  await createUser(env.DB, "tomorrow@example.com", "", new Date("2026-10-28T01:00:00Z")); // after the day: not counted
  const leaving = await createUser(env.DB, "leaving@example.com", "", new Date("2026-10-01T10:00:00Z"));
  await env.DB.prepare("UPDATE users SET deleted_at = ? WHERE id = ?").bind("2026-10-27T20:00:00Z", leaving.id).run();

  // The rollup that closes DAY (written 2026-10-28) — and an older one to ignore.
  await seedUsage("v-big", "2026-10-28", 1_000_000_000, 200_000_000, 30.4, 200);
  await seedUsage("v-small", "2026-10-28", 5_000_000, 0, 3.6, 10);
  await seedUsage("v-quiet", "2026-10-28", 1_000, 0, 0, 0);
  await seedUsage("v-legacy", "2026-10-28", 0, 0, 0, null); // older vault worker: no notes count
  await seedUsage("v-big", "2026-10-27", 999, 999, 999, 999);

  await setCounter(`${DAY}T09:10`, "sign_in", 20);
  await setCounter(`${DAY}T23:50`, "sign_in", 5);
  await setCounter("2026-10-28T00:00", "sign_in", 7); // next day
  await setCounter("2026-10-26T23:50", "sign_in", 9); // previous day
  await setCounter(`${DAY}T12:00`, "http_5xx", 2);
  await setCounter(`${DAY}T00:00`, "health_ok", 143);
  await setCounter(`${DAY}T13:00`, "health_fail", 1);
}

// --- the daily line ------------------------------------------------------------

describe("daily ops line", () => {
  test("seeded day → the exact line, stored, logged, sent to every recipient + the webhook once", async () => {
    await seedDay();
    const sender = opsSender();
    const hook = fakeWebhook();
    const logs: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((m: unknown) => void logs.push(String(m)));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await runDailyLine(opsEnv({ ENVIRONMENT: "production" }), sender, { now: RUN_AT, fetchFn: hook.fn }).finally(
      () => {
        log.mockRestore();
        err.mockRestore();
      },
    );

    const expected =
      "parachute-cloud 2026-10-27 · users 4 (+3) · active vaults 2 · notes changed 210 · storage 1.2 GB · " +
      "voice 34 min this month · sign-ins 25 · deletions pending 1 · alerts 0 · 5xx 2 · health ok 143/144";
    expect(r.day).toBe(DAY);
    expect(r.line).toBe(expected);

    // Stored (the /admin + JSON source of truth).
    const row = await env.DB.prepare("SELECT line, json FROM ops_daily WHERE day = ?").bind(DAY).first<{ line: string; json: string }>();
    expect(row?.line).toBe(expected);
    expect(JSON.parse(row!.json)).toMatchObject({ users: 4, usersNew: 3, notesChanged: 210, healthOk: 143, healthRuns: 144 });

    // Logged as event=ops_daily line="…".
    expect(logs).toContain(`event=ops_daily day=${DAY} line=${JSON.stringify(expected)}`);

    // Every recipient, one email each; the webhook exactly once.
    expect(sender.sent.map((m) => m.to)).toEqual(["ops-a@example.com", "ops-b@example.com"]);
    expect(sender.sent[0]!.subject).toBe(`[parachute-cloud production] daily — ${DAY}`);
    expect(sender.sent[0]!.text.startsWith(expected)).toBe(true);
    expect(hook.calls).toHaveLength(1);
    expect(hook.calls[0]!.url).toBe(WEBHOOK);
    expect(hook.calls[0]!.body).toEqual({ text: expected, severity: "info", key: `daily:${DAY}`, at: RUN_AT.toISOString() });

    // No personal data anywhere it goes.
    for (const out of [expected, sender.sent[0]!.text, row!.json]) {
      expect(out).not.toContain("@example.com");
      expect(out).not.toContain("v-big");
    }
  });

  test("an empty day reads honestly: n/a where nothing was recorded, the environment named off production", async () => {
    const stats = await collectDailyStats(env.DB, DAY, "staging");
    expect(renderDailyLine(stats)).toBe(
      "parachute-cloud staging 2026-10-27 · users 0 (+0) · active vaults n/a · notes changed n/a · storage n/a · " +
        "voice n/a this month · sign-ins 0 · deletions pending 0 · alerts 0 · 5xx 0 · health ok 0/144",
    );
  });

  test("a failed rollup shows its age: storage from the last rollup, marked 'as of'", async () => {
    await seedUsage("v-a", "2026-10-26", 2_500_000, 0, 1, 3);
    const stats = await collectDailyStats(env.DB, DAY, "production");
    expect(renderDailyLine(stats)).toContain("storage 2.5 MB (as of 2026-10-26)");
  });

  test("the usage cron writes the line for the day that just ended (the cron router dispatches the daily job)", async () => {
    const sender = opsSender();
    await quietly(() => handleScheduled(USAGE_CRON, opsEnv(), sender, { now: () => RUN_AT, webhookFetchFn: fakeWebhook().fn }));
    const row = await env.DB.prepare("SELECT day, line FROM ops_daily").first<{ day: string; line: string }>();
    expect(row?.day).toBe(DAY);
    expect(row?.line.startsWith(`parachute-cloud test ${DAY} · users`)).toBe(true);
    expect(sender.sent.map((m) => m.to)).toEqual(["ops-a@example.com", "ops-b@example.com"]);
  });

  test("sessions started are counted as sign-ins (counts only)", async () => {
    const { id } = await seedUser("signin@example.com");
    const at = new Date(`${DAY}T08:05:00Z`);
    await createSession(env.DB, id, at);
    await createSession(env.DB, id, at);
    expect(await sumOpsCounter(env.DB, "sign_in", DAY, "2026-10-28")).toBe(2);
    const rows = await env.DB.prepare("SELECT bucket, name, count FROM ops_counters").all();
    expect(rows.results).toEqual([{ bucket: `${DAY}T08:00`, name: "sign_in", count: 2 }]);
  });
});

// --- operator fan-out: every recipient + one webhook -----------------------------

describe("operator alerts — not only one inbox", () => {
  const T0 = new Date("2026-10-28T12:00:00Z");

  test("recipient list parsing: comma/semicolon/space, blanks + junk dropped, duplicates collapsed", () => {
    expect(operatorRecipients({ OPERATOR_ALERT_EMAIL: " a@example.com,b@example.com ; c@example.com  A@example.com,,nope " })).toEqual([
      "a@example.com",
      "b@example.com",
      "c@example.com",
    ]);
    expect(operatorRecipients({ OPERATOR_ALERT_EMAIL: "solo@example.com" })).toEqual(["solo@example.com"]);
    expect(operatorRecipients({})).toEqual([]);
  });

  test("raiseOpsAlert: every recipient + the webhook once; a second raise inside the hour reaches nobody", async () => {
    const sender = opsSender();
    const hook = fakeWebhook();
    const alert = (at: Date) =>
      raiseOpsAlert(opsEnv(), sender, { key: "test:stuck", subject: "sweep stuck", text: "details", now: at, fetchFn: hook.fn });

    expect(await quietly(() => alert(T0))).toBe(true);
    expect(sender.sent.map((m) => m.to)).toEqual(["ops-a@example.com", "ops-b@example.com"]);
    expect(sender.sent[0]!.subject).toBe("[parachute-cloud test] sweep stuck");
    expect(hook.calls).toHaveLength(1);
    expect(hook.calls[0]!.body).toMatchObject({ severity: "warning", key: "test:stuck", at: T0.toISOString() });
    expect(String(hook.calls[0]!.body.text)).toContain("sweep stuck");

    // Dedupe is per KEY across channels: 10 minutes later nobody hears it again.
    expect(await quietly(() => alert(new Date(T0.getTime() + 10 * 60_000)))).toBe(false);
    expect(sender.sent).toHaveLength(2);
    expect(hook.calls).toHaveLength(1);

    // One delivered alert counted for the daily line.
    expect(await sumOpsCounter(env.DB, "alert", "2026-10-28", "2026-10-29")).toBe(1);
  });

  test("a broken webhook never throws and never blocks the email; a broken email still pages through the webhook", async () => {
    const sender = opsSender();
    const dead = fakeWebhook("throw");
    expect(await quietly(() => raiseOpsAlert(opsEnv(), sender, { key: "k1", subject: "s", text: "t", now: T0, fetchFn: dead.fn }))).toBe(true);
    expect(sender.sent).toHaveLength(2);
    expect(dead.calls).toHaveLength(1);

    const noMail = opsSender({ ok: false, error: "email down" });
    const hook = fakeWebhook();
    expect(await quietly(() => raiseOpsAlert(opsEnv(), noMail, { key: "k2", subject: "s", text: "t", now: T0, fetchFn: hook.fn }))).toBe(true);
    expect(hook.calls).toHaveLength(1);

    // Nothing delivered anywhere → not marked, so the next tick retries.
    const both = fakeWebhook("500");
    expect(await quietly(() => raiseOpsAlert(opsEnv(), noMail, { key: "k3", subject: "s", text: "t", now: T0, fetchFn: both.fn }))).toBe(false);
    const mark = await env.DB.prepare("SELECT 1 AS x FROM ops_alerts WHERE key = 'k3'").first();
    expect(mark).toBeNull();
  });

  test("health check: a down vault pages every recipient + the webhook (critical); each run is counted", async () => {
    const sender = opsSender();
    const hook = fakeWebhook();
    const down = (async () => {
      throw new Error("connect timeout");
    }) as typeof fetch;
    const r = await quietly(() => runHealthCheck(opsEnv(), sender, { now: () => T0, fetchFn: down, webhookFetchFn: hook.fn }));
    expect(r.alerted.map((f) => f.check)).toEqual(["vault-health"]);
    expect(sender.sent.map((m) => m.to)).toEqual(["ops-a@example.com", "ops-b@example.com"]);
    expect(hook.calls).toHaveLength(1);
    expect(hook.calls[0]!.body).toMatchObject({ severity: "critical", key: "health:vault-health" });

    const healthy = (async () => Response.json({ status: "ok" })) as typeof fetch;
    await runHealthCheck(opsEnv(), sender, { now: () => new Date(T0.getTime() + 600_000), fetchFn: healthy, webhookFetchFn: hook.fn });
    expect(await sumOpsCounter(env.DB, "health_fail", "2026-10-28", "2026-10-29")).toBe(1);
    expect(await sumOpsCounter(env.DB, "health_ok", "2026-10-28", "2026-10-29")).toBe(1);
  });
});

// --- the 5xx counter + error-rate alert ------------------------------------------

describe("5xx counter and error-rate alert", () => {
  test("a 5xx response through the real worker export is counted (after the response, via waitUntil); a 2xx is not", async () => {
    const ctx = createExecutionContext();
    const bad = await worker.fetch(new Request(`${ISSUER}/vault/anything`), env, ctx); // 503 route_missing by design
    expect(bad.status).toBe(503);
    const ok = await worker.fetch(new Request(`${ISSUER}/health`), env, ctx);
    expect(ok.status).toBe(200);
    await waitOnExecutionContext(ctx);
    const rows = await env.DB.prepare("SELECT name, count FROM ops_counters").all();
    expect(rows.results).toEqual([{ name: "http_5xx", count: 1 }]);
  });

  test("the health tick alerts when the 10 minutes just closed reached the threshold — and not below it", async () => {
    const now = new Date("2026-10-28T12:10:30Z");
    const closed = opsBucket(new Date("2026-10-28T12:05:00Z")); // "2026-10-28T12:00"
    const healthy = (async () => Response.json({ status: "ok" })) as typeof fetch;

    await setCounter(closed, "http_5xx", 4);
    const quiet = opsSender();
    const below = await quietly(() =>
      runHealthCheck(opsEnv({ OPS_5XX_ALERT_THRESHOLD: "5" }), quiet, { now: () => now, fetchFn: healthy, webhookFetchFn: fakeWebhook().fn }),
    );
    expect(below.errors5xx).toBe(4);
    expect(quiet.sent).toHaveLength(0);

    await env.DB.prepare("UPDATE ops_counters SET count = 5 WHERE bucket = ? AND name = 'http_5xx'").bind(closed).run();
    const loud = opsSender();
    const hook = fakeWebhook();
    const at = await quietly(() =>
      runHealthCheck(opsEnv({ OPS_5XX_ALERT_THRESHOLD: "5" }), loud, { now: () => now, fetchFn: healthy, webhookFetchFn: hook.fn }),
    );
    expect(at.errors5xx).toBe(5);
    expect(loud.sent.map((m) => m.subject)).toEqual([
      "[parachute-cloud test] 5 server errors (5xx) in 10 minutes",
      "[parachute-cloud test] 5 server errors (5xx) in 10 minutes",
    ]);
    expect(hook.calls[0]!.body).toMatchObject({ key: "errors:5xx", severity: "warning" });
  });
});

// --- read endpoints ---------------------------------------------------------------

describe("reading the lines", () => {
  async function storeLines(): Promise<void> {
    for (const day of ["2026-10-25", "2026-10-26", "2026-10-27"]) {
      await env.DB.prepare("INSERT INTO ops_daily (day, line, json, created_at) VALUES (?, ?, ?, ?)")
        .bind(day, `parachute-cloud ${day} · users 1 (+0)`, JSON.stringify({ day, users: 1 }), `${day}T03:30:00Z`)
        .run();
    }
  }
  const opsGet = (headers: Record<string, string> = {}) => new Request(`${ISSUER}/ops/daily`, { headers });

  test("GET /ops/daily: 404 while OPS_READ_TOKEN is unset — even with a bearer", async () => {
    const res = await worker.fetch(opsGet({ authorization: "Bearer anything" }), { ...env, OPS_READ_TOKEN: undefined });
    expect(res.status).toBe(404);
  });

  test("GET /ops/daily: 401 for a missing or wrong bearer, 200 JSON (newest first, ?days) for the right one", async () => {
    await storeLines();
    const e = { ...env, OPS_READ_TOKEN: "correct-ops-read-token" };
    expect((await worker.fetch(opsGet(), e)).status).toBe(401);
    const wrong = await worker.fetch(opsGet({ authorization: "Bearer correct-ops-read-tokeN" }), e);
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("www-authenticate")).toBe("Bearer");
    expect((await worker.fetch(opsGet({ authorization: "Bearer correct" }), e)).status).toBe(401);

    const res = await worker.fetch(opsGet({ authorization: "Bearer correct-ops-read-token" }), e);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { days: Array<{ day: string; line: string; data: { users: number } }> };
    expect(body.days.map((d) => d.day)).toEqual(["2026-10-27", "2026-10-26", "2026-10-25"]);
    expect(body.days[0]!.line).toBe("parachute-cloud 2026-10-27 · users 1 (+0)");
    expect(body.days[0]!.data.users).toBe(1);

    const two = await worker.fetch(new Request(`${ISSUER}/ops/daily?days=2`, { headers: { authorization: "Bearer correct-ops-read-token" } }), e);
    expect(((await two.json()) as { days: unknown[] }).days).toHaveLength(2);
  });

  test("/admin shows the lines at the top and /admin/daily.json serves them — to an operator only", async () => {
    await storeLines();
    const { id } = await seedUser("daily-op@example.com");
    await env.DB.prepare("UPDATE users SET role = 'operator' WHERE id = ?").bind(id).run();
    const cookie = `parachute_id_csrf=${CSRF}; parachute_id_session=${await seedSession(id)}`;

    const html = await (await worker.fetch(new Request(`${ISSUER}/admin`, { headers: { cookie } }), env)).text();
    const first = html.indexOf('data-testid="admin-daily-line"');
    expect(first).toBeGreaterThan(-1);
    expect(first).toBeLessThan(html.indexOf('class="statgrid"')); // at the top
    expect(html).toContain("parachute-cloud 2026-10-27 · users 1 (+0)");

    const json = await worker.fetch(new Request(`${ISSUER}/admin/daily.json`, { headers: { cookie } }), env);
    expect(json.status).toBe(200);
    expect(((await json.json()) as { days: unknown[] }).days).toHaveLength(3);

    const anon = await worker.fetch(new Request(`${ISSUER}/admin/daily.json`), env);
    expect(anon.status).toBe(404);
  });

  test("POST /__test/ops-daily-run runs the job now off production, and 404s on production", async () => {
    const res = await quietly(async () => worker.fetch(new Request(`${ISSUER}/__test/ops-daily-run?day=${DAY}`, { method: "POST" }), env));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { day: string; line: string };
    expect(body.day).toBe(DAY);
    expect(body.line.startsWith(`parachute-cloud test ${DAY} · `)).toBe(true);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM ops_daily").first<{ n: number }>())?.n).toBe(1);

    const bad = await worker.fetch(new Request(`${ISSUER}/__test/ops-daily-run?day=yesterday`, { method: "POST" }), env);
    expect(bad.status).toBe(400);
    const prod = await worker.fetch(new Request(`${ISSUER}/__test/ops-daily-run`, { method: "POST" }), { ...env, ENVIRONMENT: "production" });
    expect(prod.status).toBe(404);
  });
});
