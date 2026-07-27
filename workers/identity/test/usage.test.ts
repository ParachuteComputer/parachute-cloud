/**
 * The daily usage rollup (src/usage.ts) + its console surface:
 *   - USAGE_CRON routing (ops.ts) — the rollup, never the health check/digest,
 *   - runUsageRollup: per-vault internal-config reads through the mint seam
 *     (claims pinned: first-party client, admin verb, aud-pinned, 60s TTL),
 *     one `vault_usage` row per (vault, UTC day), same-day re-runs REFRESH,
 *     per-vault failures skip+log+continue, the per-run cap marks `capped`,
 *   - latestUsageForVaults: newest row per vault, absent when none,
 *   - the console render: "Using X of Y" per card from the latest row,
 *     "usage appears within a day" when none, the plan line's total,
 *   - the staging-only /__test/usage-run trigger (404 in production).
 */
import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import worker from "../src/index.ts";
import { USAGE_CRON, handleScheduled, routeCron } from "../src/ops.ts";
import { USAGE_RUN_CAP, latestUsageForVaults, runUsageRollup } from "../src/usage.ts";
import { validateAccessToken } from "../src/tokens.ts";
import type { OAuthDeps } from "../src/oauth-shared.ts";
import type { EmailSender, SendResult } from "../src/email.ts";
import { CSRF, ISSUER, deps, seedSession, seedUser, seedVault } from "./helpers.ts";

const NOW = new Date("2026-07-03T03:30:00Z");
const TODAY = "2026-07-03";

/** Rollup deps: the helpers' deps + the path-form vault origin fetchMock intercepts. */
function rollupDeps(now: () => Date = () => NOW): OAuthDeps {
  return { ...deps(now), vaultOrigin: env.VAULT_ORIGIN };
}

/** Intercept GET /vault/<name>/api/internal/config with a usage split. */
function interceptConfigGet(
  vault: string,
  body: Record<string, unknown>,
  opts: { status?: number; capture?: (auth: string | undefined) => void } = {},
): void {
  fetchMock
    .get(env.VAULT_ORIGIN!)
    .intercept({
      path: `/vault/${vault}/api/internal/config`,
      method: "GET",
      headers: (h: Record<string, string>) => {
        opts.capture?.(h.authorization ?? h.Authorization);
        return true;
      },
    })
    .reply(opts.status ?? 200, body, { headers: { "content-type": "application/json" } });
}

function splitBody(dbBytes: number, r2Bytes: number): Record<string, unknown> {
  return {
    name: "x",
    cap_bytes: null,
    resolved_cap_bytes: 104857600,
    used_bytes: dbBytes + r2Bytes,
    db_bytes: dbBytes,
    r2_bytes: r2Bytes,
  };
}

async function usageRows(): Promise<Array<{ vault_name: string; day: string; db_bytes: number; r2_bytes: number }>> {
  const res = await env.DB.prepare("SELECT vault_name, day, db_bytes, r2_bytes FROM vault_usage ORDER BY vault_name, day").all<{
    vault_name: string;
    day: string;
    db_bytes: number;
    r2_bytes: number;
  }>();
  return res.results ?? [];
}

/** Silence the structured event= lines the failure paths intentionally emit. */
function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  return fn().finally(() => {
    err.mockRestore();
    log.mockRestore();
  });
}

/** A sender that must stay silent — the usage rollup never emails anyone. */
function silentSender(): EmailSender & { sent: unknown[] } {
  const sent: unknown[] = [];
  return {
    kind: "devlog",
    sent,
    async sendMagicLink(): Promise<SendResult> {
      sent.push("magic");
      return { ok: true };
    },
    async sendOps(msg): Promise<SendResult> {
      sent.push(msg);
      return { ok: true };
    },
    async sendDrip(): Promise<SendResult> {
      sent.push("drip");
      return { ok: true };
    },
  };
}

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

// --- cron routing --------------------------------------------------------------

describe("usage cron routing", () => {
  test("USAGE_CRON maps to the rollup; the other patterns are undisturbed", () => {
    expect(USAGE_CRON).toBe("30 3 * * *");
    expect(routeCron(USAGE_CRON)).toBe("usage");
    expect(routeCron("30 3 * * 1")).toBe("health"); // near-miss degrades safely
  });

  test("handleScheduled dispatches the usage cron to the rollup — no email, no health probe", async () => {
    // Zero vaults → the rollup makes no vault call; a misroute to the health
    // check would consume a fetch interceptor (none registered → throw inside
    // the check → alert email), and digest/drip would email. Silence proves
    // the route.
    const sender = silentSender();
    await quietly(() => handleScheduled(USAGE_CRON, env, sender));
    expect(sender.sent).toHaveLength(0);
    expect(await usageRows()).toEqual([]);
  });
});

// --- runUsageRollup -------------------------------------------------------------

describe("runUsageRollup", () => {
  test("reads each vault's split through the mint seam and writes one row per vault", async () => {
    const { id: owner } = await seedUser("roll@example.com");
    await seedVault("roll-a", owner);
    await seedVault("roll-b", owner);

    let auth: string | undefined;
    interceptConfigGet("roll-a", splitBody(1111, 222), { capture: (a) => (auth = a) });
    interceptConfigGet("roll-b", splitBody(50_000_000, 0));

    // REAL clock here (not the pinned NOW): validateAccessToken below verifies
    // the minted 60s token against wall time, so a past clock reads as expired.
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const summary = await quietly(() => runUsageRollup(env, rollupDeps(() => now)));
    expect(summary).toEqual({ day: today, vaults: 2, recorded: 2, failed: 0, capped: false });
    expect(await usageRows()).toEqual([
      { vault_name: "roll-a", day: today, db_bytes: 1111, r2_bytes: 222 },
      { vault_name: "roll-b", day: today, db_bytes: 50_000_000, r2_bytes: 0 },
    ]);

    // The read rides the SAME first-party mint contract as the cap push:
    // aud-pinned, resource-narrowed admin scope, 60s TTL, console client id.
    const token = auth!.replace(/^Bearer /, "");
    const { payload } = await validateAccessToken(env.DB, token, ISSUER);
    expect(payload.aud).toBe("vault.roll-a");
    expect(payload.scope).toBe("vault:roll-a:admin");
    expect(payload.client_id).toBe("parachute-console");
    expect(payload.sub).toBe(owner);
    expect((payload.exp as number) - (payload.iat as number)).toBe(60);
  });

  test("records the DO's transcribe_minutes into the rollup (cloud#56 voice)", async () => {
    const { id: owner } = await seedUser("voice-roll@example.com");
    await seedVault("voice-a", owner);
    // A pre-voice DO omits the field → defaults to 0 (readVaultUsage contract).
    await seedVault("voice-legacy", owner);
    interceptConfigGet("voice-a", { ...splitBody(100, 200), transcribe_minutes: 12.5 });
    interceptConfigGet("voice-legacy", splitBody(10, 0)); // no transcribe_minutes

    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const summary = await quietly(() => runUsageRollup(env, rollupDeps(() => now)));
    expect(summary.recorded).toBe(2);

    const row = await env.DB
      .prepare("SELECT transcribe_minutes AS m FROM vault_usage WHERE vault_name = 'voice-a' AND day = ?")
      .bind(today)
      .first<{ m: number }>();
    expect(row?.m).toBe(12.5);
    // The console read surfaces it; the legacy vault reads 0.
    const map = await latestUsageForVaults(env.DB, ["voice-a", "voice-legacy"]);
    expect(map.get("voice-a")?.transcribeMinutes).toBe(12.5);
    expect(map.get("voice-legacy")?.transcribeMinutes).toBe(0);
  });

  test("a failing vault is skipped + logged; the run continues (self-heals next run)", async () => {
    const { id: owner } = await seedUser("skip@example.com");
    await seedVault("skip-bad", owner);
    await seedVault("skip-good", owner);
    interceptConfigGet("skip-bad", { error: "boom" }, { status: 500 });
    interceptConfigGet("skip-good", splitBody(2222, 0));

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const summary = await runUsageRollup(env, rollupDeps());
    expect(summary).toEqual({ day: TODAY, vaults: 2, recorded: 1, failed: 1, capped: false });
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("event=usage_fetch_failed vault=skip-bad"))).toBe(true);
    errSpy.mockRestore();
    logSpy.mockRestore();

    expect(await usageRows()).toEqual([{ vault_name: "skip-good", day: TODAY, db_bytes: 2222, r2_bytes: 0 }]);
  });

  test("a 200 body WITHOUT the split (stale vault worker) counts as a failure", async () => {
    const { id: owner } = await seedUser("stale@example.com");
    await seedVault("stale-v", owner);
    interceptConfigGet("stale-v", { name: "stale-v", cap_bytes: null, resolved_cap_bytes: 1, used_bytes: 5 });
    const summary = await quietly(() => runUsageRollup(env, rollupDeps()));
    expect(summary.failed).toBe(1);
    expect(summary.recorded).toBe(0);
    expect(await usageRows()).toEqual([]);
  });

  test("a same-day re-run REFRESHES the row (upsert), never duplicates it", async () => {
    const { id: owner } = await seedUser("refresh@example.com");
    await seedVault("refresh-v", owner);
    interceptConfigGet("refresh-v", splitBody(1000, 0));
    await quietly(() => runUsageRollup(env, rollupDeps()));
    interceptConfigGet("refresh-v", splitBody(9000, 500));
    await quietly(() => runUsageRollup(env, rollupDeps()));
    expect(await usageRows()).toEqual([{ vault_name: "refresh-v", day: TODAY, db_bytes: 9000, r2_bytes: 500 }]);
  });

  test("the per-run cap bounds a run and marks it capped (vaults beyond the cap wait)", async () => {
    const { id: owner } = await seedUser("cap@example.com");
    await seedVault("cap-a", owner);
    await seedVault("cap-b", owner);
    await seedVault("cap-c", owner);
    // Enumeration is ORDER BY name — a and b are read, c waits for pagination.
    interceptConfigGet("cap-a", splitBody(1, 0));
    interceptConfigGet("cap-b", splitBody(2, 0));
    const summary = await quietly(() => runUsageRollup(env, rollupDeps(), { runCap: 2 }));
    expect(summary).toEqual({ day: TODAY, vaults: 2, recorded: 2, failed: 0, capped: true });
    expect((await usageRows()).map((r) => r.vault_name)).toEqual(["cap-a", "cap-b"]);
    expect(USAGE_RUN_CAP).toBe(500); // the real bound the cron runs with
  });

  test("onlyVault scopes the run to a SINGLE vault — the rest of the fleet is untouched (O(1), not O(fleet))", async () => {
    const { id: owner } = await seedUser("usage-scope@example.com");
    await seedVault("uscope-mine", owner);
    await seedVault("uscope-other", owner);
    // ONLY the scoped vault's config read is intercepted; uscope-other must not
    // be read at all — an unexpected call trips disableNetConnect, and
    // assertNoPendingInterceptors (afterEach) proves the scoped interceptor was
    // consumed. This is what keeps smoke §14's rollup O(1) as the fleet grows
    // (cloud#224, mirroring the snapshot-sweep scope in cloud#166/#218).
    interceptConfigGet("uscope-mine", splitBody(3333, 111));
    const summary = await quietly(() => runUsageRollup(env, rollupDeps(), { onlyVault: "uscope-mine" }));
    expect(summary).toEqual({ day: TODAY, vaults: 1, recorded: 1, failed: 0, capped: false });
    expect((await usageRows()).map((r) => r.vault_name)).toEqual(["uscope-mine"]);
  });

  test("onlyVault for an unknown name → an empty, clean run (no vault reads)", async () => {
    const summary = await quietly(() => runUsageRollup(env, rollupDeps(), { onlyVault: "does-not-exist" }));
    expect(summary).toEqual({ day: TODAY, vaults: 0, recorded: 0, failed: 0, capped: false });
    expect(await usageRows()).toEqual([]);
  });
});

// --- latestUsageForVaults --------------------------------------------------------

describe("latestUsageForVaults", () => {
  async function seedRow(vault: string, day: string, dbBytes: number, r2Bytes: number): Promise<void> {
    await env.DB.prepare("INSERT INTO vault_usage (vault_name, day, db_bytes, r2_bytes) VALUES (?, ?, ?, ?)")
      .bind(vault, day, dbBytes, r2Bytes)
      .run();
  }

  test("returns the NEWEST row per requested vault; unrecorded vaults are absent", async () => {
    await seedRow("lat-a", "2026-07-01", 100, 0);
    await seedRow("lat-a", "2026-07-02", 200, 50);
    await seedRow("lat-b", "2026-06-30", 999, 1);
    await seedRow("lat-other", "2026-07-02", 5, 5); // not requested — never returned
    const map = await latestUsageForVaults(env.DB, ["lat-a", "lat-b", "lat-new"]);
    expect(map.get("lat-a")).toEqual({ vaultName: "lat-a", day: "2026-07-02", dbBytes: 200, r2Bytes: 50, transcribeMinutes: 0 });
    expect(map.get("lat-b")).toEqual({ vaultName: "lat-b", day: "2026-06-30", dbBytes: 999, r2Bytes: 1, transcribeMinutes: 0 });
    expect(map.has("lat-new")).toBe(false);
    expect(map.has("lat-other")).toBe(false);
  });

  test("empty input → empty map, no query", async () => {
    expect((await latestUsageForVaults(env.DB, [])).size).toBe(0);
  });
});

// --- the console surface ----------------------------------------------------------

describe("console usage display", () => {
  function sessionCookie(sessionId: string): string {
    return `parachute_id_csrf=${CSRF}; parachute_id_session=${sessionId}`;
  }

  async function consoleHtml(sessionId: string): Promise<string> {
    const res = await worker.fetch(
      new Request(`${ISSUER}/console`, { headers: { cookie: sessionCookie(sessionId) } }),
      env,
    );
    expect(res.status).toBe(200);
    return res.text();
  }

  async function seedRow(vault: string, day: string, dbBytes: number, r2Bytes: number): Promise<void> {
    await env.DB.prepare("INSERT INTO vault_usage (vault_name, day, db_bytes, r2_bytes) VALUES (?, ?, ?, ?)")
      .bind(vault, day, dbBytes, r2Bytes)
      .run();
  }

  test('a recorded vault card reads "Using X of Y" (latest row, human units, plan cap)', async () => {
    const { id: userId } = await seedUser("shows@example.com");
    await seedVault("shows-v", userId);
    await seedRow("shows-v", "2026-07-01", 100_000, 0); // stale — must lose to the newer row
    await seedRow("shows-v", "2026-07-02", 150_000, 59_715); // ≈0.2 MiB total
    const html = await consoleHtml(await seedSession(userId));
    expect(html).toContain('data-testid="vault-usage"');
    expect(html).toContain("Using 0.2 MB of 8.5 GiB"); // trial cap (mirrors plus: 500 MB + 8 GiB)
    // The plan line carries the across-vaults total.
    expect(html).toContain('data-testid="usage-total"');
    expect(html).toMatch(/usage-total[^<]*>&middot; Using 0\.2 MB/);
  });

  test('no rollup row yet → "usage appears within a day", and NO plan-line total', async () => {
    const { id: userId } = await seedUser("fresh-usage@example.com");
    await seedVault("fresh-v", userId);
    const html = await consoleHtml(await seedSession(userId));
    expect(html).toContain("Usage appears within a day.");
    expect(html).not.toContain('data-testid="usage-total"');
  });

  test("two vaults (grandfathered) → per-card lines + the summed total on the plan line", async () => {
    const { id: userId } = await seedUser("two@example.com");
    await seedVault("two-a", userId);
    await seedVault("two-b", userId);
    await seedRow("two-a", "2026-07-02", 1_048_576, 0); // 1.0 MB
    await seedRow("two-b", "2026-07-02", 2_097_152, 1_048_576); // 3.0 MB
    const html = await consoleHtml(await seedSession(userId));
    expect(html).toContain("Using 1.0 MB of 8.5 GiB"); // trial cap (500 MB notes + 8 GiB attach)
    expect(html).toContain("Using 3.0 MB of 8.5 GiB");
    expect(html).toMatch(/usage-total[^<]*>&middot; Using 4\.0 MB/);
  });

  test("a power-plan card reads against its 51 GiB cap (distinct from the trial default's 8.5 GiB)", async () => {
    const { id: userId } = await seedUser("paid@example.com");
    await env.DB.prepare("UPDATE users SET plan = 'power' WHERE id = ?").bind(userId).run();
    await seedVault("paid-v", userId);
    await seedRow("paid-v", "2026-07-02", 3_221_225_472, 0); // 3 GiB
    const html = await consoleHtml(await seedSession(userId));
    expect(html).toContain("Using 3.0 GB of 51 GiB");
  });
});

// --- the staging-only trigger -----------------------------------------------------

describe("staging usage trigger", () => {
  test("POST /__test/usage-run answers the summary off-production and 404s ON production", async () => {
    const { id: owner } = await seedUser("trigger-usage@example.com");
    await seedVault("trig-v", owner);
    interceptConfigGet("trig-v", splitBody(4242, 42));

    const req = () => new Request(`${ISSUER}/__test/usage-run`, { method: "POST" });
    const staging = await quietly(async () => worker.fetch(req(), env));
    expect(staging.status).toBe(200);
    const summary = (await staging.json()) as { day: string; recorded: number };
    expect(summary.recorded).toBe(1);
    expect(await usageRows()).toEqual([
      { vault_name: "trig-v", day: summary.day, db_bytes: 4242, r2_bytes: 42 },
    ]);

    const prod = await worker.fetch(req(), { ...env, ENVIRONMENT: "production" });
    expect(prod.status).toBe(404);
  });

  test("?vault=<name> scopes the trigger to that one vault (smoke §14's O(1) rollup setup)", async () => {
    const { id: owner } = await seedUser("trigger-scope-usage@example.com");
    await seedVault("utrig-a", owner);
    await seedVault("utrig-b", owner);
    // Only utrig-a is intercepted; utrig-b must never be read — no interceptor
    // + assertNoPendingInterceptors proves the trigger scoped to the one vault.
    interceptConfigGet("utrig-a", splitBody(555, 5));
    const res = await quietly(async () =>
      worker.fetch(new Request(`${ISSUER}/__test/usage-run?vault=utrig-a`, { method: "POST" }), env),
    );
    expect(res.status).toBe(200);
    const summary = (await res.json()) as { vaults: number; recorded: number };
    expect(summary.vaults).toBe(1); // only the scoped vault, not the fleet
    expect(summary.recorded).toBe(1);
    expect((await usageRows()).map((r) => r.vault_name)).toEqual(["utrig-a"]);
  });
});
