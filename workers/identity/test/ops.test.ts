/**
 * Ops observability (src/ops.ts): cron routing, the health check + 1-hour alert
 * dedupe, the weekly counts-only digest, and the public /health endpoint.
 *
 * Same conventions as the rest of the corpus: handlers driven directly with an
 * injected clock/fetch/sender against the real D1, plus one pass through the
 * REAL worker export (`worker.scheduled` via createScheduledController +
 * fetchMock) to pin the wiring the deployed cron actually exercises.
 */
import {
  createExecutionContext,
  createScheduledController,
  env,
  fetchMock,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import worker from "../src/index.ts";
import type { EmailSender, OpsEmail, SendResult } from "../src/email.ts";
import {
  ALERT_DEDUPE_MS,
  DIGEST_CRON,
  HEALTH_CRON,
  bumpMagicLinkEvent,
  collectDigestStats,
  handleScheduled,
  renderDigest,
  routeCron,
  runHealthCheck,
  sendWeeklyDigest,
} from "../src/ops.ts";
import { createUser } from "../src/users.ts";
import { ISSUER } from "./helpers.ts";

/** Capturing ops sender; `result` lets a test simulate a failing email channel. */
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
  };
}

const healthyFetch: typeof fetch = async () => Response.json({ status: "ok" });
const downFetch: typeof fetch = async () => {
  throw new Error("connect timeout");
};
const erroringFetch: typeof fetch = async () => Response.json({ error: "boom" }, { status: 500 });

/** Silence the structured event= lines these paths intentionally emit. */
function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  return fn().finally(() => {
    err.mockRestore();
    log.mockRestore();
  });
}

// --- cron routing ------------------------------------------------------------

describe("cron routing", () => {
  test("each configured pattern maps to its job; unknown patterns degrade to the health check", () => {
    expect(routeCron(HEALTH_CRON)).toBe("health");
    expect(routeCron(DIGEST_CRON)).toBe("digest");
    // Safe default: a drifted/unknown pattern means extra liveness checks, not a no-op.
    expect(routeCron("0 0 1 1 *")).toBe("health");
    expect(routeCron("")).toBe("health");
  });

  test("handleScheduled dispatches the digest cron to the digest, the health cron to the check", async () => {
    const digest = opsSender();
    await quietly(() => handleScheduled(DIGEST_CRON, env, digest));
    expect(digest.sent).toHaveLength(1);
    expect(digest.sent[0]!.subject).toContain("weekly ops digest");

    const health = opsSender();
    await quietly(() => handleScheduled(HEALTH_CRON, env, health, { fetchFn: downFetch }));
    expect(health.sent).toHaveLength(1);
    expect(health.sent[0]!.subject).toContain("health check failed");
  });
});

// --- /health endpoints ---------------------------------------------------------

describe("identity /health", () => {
  test("public, unauthenticated, cheap JSON", async () => {
    const res = await worker.fetch(new Request(`${ISSUER}/health`), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", service: "identity" });
  });
});

// --- health check + alert dedupe ----------------------------------------------

describe("health check + alerting", () => {
  const T0 = new Date("2026-07-02T12:00:00Z");
  const at = (offsetMs: number) => ({ now: () => new Date(T0.getTime() + offsetMs) });

  test("healthy: no failures, no email", async () => {
    const sender = opsSender();
    const r = await runHealthCheck(env, sender, { ...at(0), fetchFn: healthyFetch });
    expect(r.failures).toEqual([]);
    expect(r.alerted).toEqual([]);
    expect(sender.sent).toHaveLength(0);
  });

  test("vault down (network error) → one alert to OPERATOR_ALERT_EMAIL, deduped for an hour", async () => {
    const sender = opsSender();
    const first = await quietly(() => runHealthCheck(env, sender, { ...at(0), fetchFn: downFetch }));
    expect(first.failures.map((f) => f.check)).toEqual(["vault-health"]); // identity D1 is fine here
    expect(first.alerted.map((f) => f.check)).toEqual(["vault-health"]);
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]!.to).toBe(env.OPERATOR_ALERT_EMAIL);
    expect(sender.sent[0]!.subject).toContain("vault-health");
    expect(sender.sent[0]!.text).toContain("connect timeout");

    // 10 minutes later (the next cron tick): still failing, still silent.
    const second = await quietly(() => runHealthCheck(env, sender, { ...at(10 * 60 * 1000), fetchFn: downFetch }));
    expect(second.failures).toHaveLength(1);
    expect(second.alerted).toEqual([]);
    expect(sender.sent).toHaveLength(1);

    // Exactly AT the boundary (now - last == ALERT_DEDUPE_MS): no longer
    // "within" the window (the guard is strict <) — it rings again.
    const third = await quietly(() => runHealthCheck(env, sender, { ...at(ALERT_DEDUPE_MS), fetchFn: downFetch }));
    expect(third.alerted.map((f) => f.check)).toEqual(["vault-health"]);
    expect(sender.sent).toHaveLength(2);

    // ...and one tick short of the NEW mark's window stays quiet.
    const fourth = await quietly(() => runHealthCheck(env, sender, { ...at(ALERT_DEDUPE_MS + 10 * 60 * 1000), fetchFn: downFetch }));
    expect(fourth.alerted).toEqual([]);
    expect(sender.sent).toHaveLength(2);
  });

  test("vault 500 counts as down too", async () => {
    const sender = opsSender();
    const r = await quietly(() => runHealthCheck(env, sender, { ...at(0), fetchFn: erroringFetch }));
    expect(r.failures[0]!.check).toBe("vault-health");
    expect(r.failures[0]!.detail).toBe("HTTP 500");
    expect(sender.sent).toHaveLength(1);
  });

  test("a failed alert email is NOT marked alerted — the next tick retries", async () => {
    const broken = opsSender({ ok: false, error: "email channel down" });
    const first = await quietly(() => runHealthCheck(env, broken, { ...at(0), fetchFn: downFetch }));
    expect(first.alerted).toEqual([]); // send failed → no dedupe mark
    expect(broken.sent).toHaveLength(1); // the attempt happened

    const working = opsSender();
    const second = await quietly(() => runHealthCheck(env, working, { ...at(10 * 60 * 1000), fetchFn: downFetch }));
    expect(second.alerted.map((f) => f.check)).toEqual(["vault-health"]); // retried inside the hour
    expect(working.sent).toHaveLength(1);
  });
});

// --- magic-link counters + the weekly digest ------------------------------------

describe("ops counters + weekly digest", () => {
  const NOW = new Date("2026-07-02T14:00:00Z");
  const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

  test("bumpMagicLinkEvent upserts per (day, event)", async () => {
    await bumpMagicLinkEvent(env.DB, "sent", NOW);
    await bumpMagicLinkEvent(env.DB, "sent", NOW);
    await bumpMagicLinkEvent(env.DB, "failed", NOW);
    await bumpMagicLinkEvent(env.DB, "sent", daysAgo(1));
    const rows = await env.DB.prepare("SELECT day, event, count FROM magic_link_events ORDER BY day, event").all();
    expect(rows.results).toEqual([
      { day: "2026-07-01", event: "sent", count: 1 },
      { day: "2026-07-02", event: "failed", count: 1 },
      { day: "2026-07-02", event: "sent", count: 2 },
    ]);
  });

  async function seedDigestFixtures(): Promise<void> {
    // Users: one old, one inside the 7-day window.
    await createUser(env.DB, "old-user@example.com", "", daysAgo(30));
    await createUser(env.DB, "new-user@example.com", "", daysAgo(1));
    // Vaults: one old, one new (direct insert — explicit created_at).
    const seed = (name: string, at: Date) =>
      env.DB.prepare("INSERT INTO vaults (name, owner_user_id, created_at) VALUES (?, 'u-test', ?)")
        .bind(name, at.toISOString())
        .run();
    await seed("old-vault", daysAgo(30));
    await seed("new-vault", daysAgo(2));
    // Magic-link counters: in-window sent=5/failed=2, out-of-window sent=99.
    const bump = (day: Date, event: string, count: number) =>
      env.DB.prepare("INSERT INTO magic_link_events (day, event, count) VALUES (?, ?, ?)")
        .bind(day.toISOString().slice(0, 10), event, count)
        .run();
    await bump(daysAgo(3), "sent", 5);
    await bump(daysAgo(3), "failed", 2);
    await bump(daysAgo(10), "sent", 99);
  }

  test("collectDigestStats: totals, 7-day windows, counter sums", async () => {
    await seedDigestFixtures();
    expect(await collectDigestStats(env.DB, NOW)).toEqual({
      usersTotal: 2,
      usersNew7d: 1,
      vaultsTotal: 2,
      vaultsNew7d: 1,
      magicSent7d: 5,
      magicFailed7d: 2,
    });
  });

  test("sendWeeklyDigest emails the counts — and nothing else (PII-free)", async () => {
    await seedDigestFixtures();
    const sender = opsSender();
    await quietly(() => sendWeeklyDigest(env, sender, { now: () => NOW }));
    expect(sender.sent).toHaveLength(1);
    const mail = sender.sent[0]!;
    expect(mail.to).toBe(env.OPERATOR_ALERT_EMAIL);
    expect(mail.subject).toBe(`[parachute-cloud test] weekly ops digest — 2026-07-02`);
    expect(mail.text).toContain("Users:        2 total (+1 in 7d)");
    expect(mail.text).toContain("Vaults:       2 total (+1 in 7d)");
    expect(mail.text).toContain("Magic links:  5 sent, 2 failed (7d)");
    expect(mail.text).not.toContain("@example.com"); // counts only, never addresses
    expect(mail.text).not.toContain("old-vault"); // ...nor vault names
  });

  test("renderDigest is deterministic given stats", () => {
    const { subject, text } = renderDigest(
      { usersTotal: 0, usersNew7d: 0, vaultsTotal: 0, vaultsNew7d: 0, magicSent7d: 0, magicFailed7d: 0 },
      "production",
      NOW,
    );
    expect(subject).toContain("production");
    expect(text).toContain("0 total (+0 in 7d)");
  });
});

// --- the real worker export (what the deployed cron invokes) ---------------------

describe("worker.scheduled wiring", () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });
  afterEach(() => fetchMock.assertNoPendingInterceptors());

  test("the health cron probes <VAULT_ORIGIN>/health through the real export", async () => {
    // env.VAULT_ORIGIN comes from wrangler.toml [vars]; the interceptor being
    // consumed (assertNoPendingInterceptors above) proves controller.cron routed
    // to the health check and the vault probe went out. Healthy → no email.
    fetchMock
      .get(env.VAULT_ORIGIN!)
      .intercept({ path: "/health" })
      .reply(200, { status: "ok" }, { headers: { "content-type": "application/json" } });

    const ctrl = createScheduledController({ scheduledTime: new Date(), cron: HEALTH_CRON });
    const ctx = createExecutionContext();
    await worker.scheduled(ctrl, env, ctx);
    await waitOnExecutionContext(ctx);
  });
});
