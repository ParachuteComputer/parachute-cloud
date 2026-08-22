/**
 * The daily usage rollup (src/usage.ts) + its console surface:
 *   - USAGE_CRON routing (ops.ts) — the rollup, never the health check/digest,
 *   - runUsageRollup: per-vault internal-config reads through the mint seam
 *     (claims pinned: first-party client, admin verb, aud-pinned, 60s TTL),
 *     one `vault_usage` row per (vault, UTC day), same-day re-runs REFRESH,
 *     idempotent plan-entitlement reconciliation through the same GET/PUT
 *     seam, per-vault failures skip+log+continue, the per-run read cap marks
 *     `capped` and the per-run PUSH cap marks `reconcileCapped` (cloud#238),
 *     and the fleet-wide cloud#227 orphan prune spares tombstoned owners whose
 *     vault rows still exist,
 *   - latestUsageForVaults: newest row per vault, absent when none,
 *   - the console render: the card's TWO meters (notes / attachments, each of
 *     its own pooled plan budget — #107) from the latest row,
 *     "usage appears within a day" when none, the plan line's total,
 *   - the staging-only /__test/usage-run trigger (404 in production).
 */
import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import worker from "../src/index.ts";
import { USAGE_CRON, handleScheduled, routeCron } from "../src/ops.ts";
import { RECONCILE_RUN_CAP, USAGE_RUN_CAP, latestUsageForVaults, runUsageRollup } from "../src/usage.ts";
import { validateAccessToken } from "../src/tokens.ts";
import type { OAuthDeps } from "../src/oauth-shared.ts";
import type { EmailSender, SendResult } from "../src/email.ts";
import { PLAN_SPECS, planEntitlement, vaultUsageLine, type VaultEntitlement } from "../src/plans.ts";
import { CAP_PUSH_MAX_ATTEMPTS, applyPlanToVaults } from "../src/vault-call.ts";
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

function splitBody(
  dbBytes: number,
  r2Bytes: number,
  entitlement: VaultEntitlement = planEntitlement("trial"),
): Record<string, unknown> {
  return {
    name: "x",
    cap_bytes: null,
    caps: entitlement.caps,
    frozen: entitlement.frozen,
    transcription_enabled: entitlement.transcription.enabled,
    transcribe_minutes_limit: entitlement.transcription.minutes_limit,
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
    expect(summary).toEqual({ day: today, vaults: 2, recorded: 2, failed: 0, reconciled: 0, capped: false, reconcileCapped: false, orphansPruned: 0 });
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

  test("END-TO-END (cloud#186): an upgrade whose push EXHAUSTS its retries leaves the customer under-entitled — the next daily rollup repairs it, and the one after is a no-op", async () => {
    // The issue's headline scenario, driven through the REAL seams rather than
    // a hand-placed mismatch: the two halves of the fix (push-time retry,
    // daily reconciler) are separately tested above, but only this test proves
    // they COMPOSE — that the state a totally-failed `applyPlanToVaults`
    // leaves behind is exactly the state the reconciler detects and repairs.
    const { id: owner } = await seedUser("e2e-upgrade@example.com");
    await seedVault("e2e-v", owner);

    // The DO starts on the trial entitlement it was created with.
    let resolved = planEntitlement("trial");
    let putAttempts = 0;
    let vaultDown = true; // the transient window: every PUT 503s
    const runDeps: OAuthDeps = {
      ...deps(() => NOW),
      vaultFetch: async (_input, init) => {
        if (init?.method === "GET") return Response.json(splitBody(4096, 128, resolved));
        if (init?.method === "PUT") {
          putAttempts++;
          if (vaultDown) return new Response("transient", { status: 503 });
          resolved = JSON.parse(String(init.body)) as VaultEntitlement;
          return Response.json({ ok: true });
        }
        return new Response("method not allowed", { status: 405 });
      },
    };

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      // 1. The customer pays and upgrades to standard — D1 flips...
      await env.DB.prepare("UPDATE users SET plan = 'standard', pending_plan = NULL WHERE id = ?").bind(owner).run();
      // ...but the entitlement push exhausts its whole retry budget.
      const pushes = await applyPlanToVaults(env.DB, runDeps, owner);
      expect(pushes).toHaveLength(1);
      expect(pushes[0]).toMatchObject({ vault: "e2e-v", ok: false, status: 503, attempts: CAP_PUSH_MAX_ATTEMPTS });
      expect(putAttempts).toBe(CAP_PUSH_MAX_ATTEMPTS);
      // THE BUG this issue is about: a paying customer on the trial's caps and
      // WITHOUT the voice entitlement they are now billed for.
      expect(resolved).toEqual(planEntitlement("trial"));
      expect(resolved.transcription.enabled).toBe(planEntitlement("trial").transcription.enabled);

      // 2. The window closes; the next daily rollup wakes and self-heals.
      vaultDown = false;
      putAttempts = 0;
      const heal = await runUsageRollup(env, runDeps, { onlyVault: "e2e-v" });
      expect(heal).toEqual({ day: TODAY, vaults: 1, recorded: 1, failed: 0, reconciled: 1, capped: false, reconcileCapped: false, orphansPruned: 0 });
      expect(putAttempts).toBe(1); // healthy vault → repaired on the first try
      // Exactly what the customer pays for — caps AND voice, no operator, no
      // scripts/backfill-plans.ts run.
      expect(resolved).toEqual(planEntitlement("standard"));
      expect(
        log.mock.calls.some((c) => String(c[0]).includes("event=entitlement_reconciled vault=e2e-v ok=true")),
      ).toBe(true);

      // 3. Idempotent: nothing is wrong any more, so the next tick pushes nothing.
      const quiet = await runUsageRollup(env, runDeps, { onlyVault: "e2e-v" });
      expect(quiet).toEqual({ day: TODAY, vaults: 1, recorded: 1, failed: 0, reconciled: 0, capped: false, reconcileCapped: false, orphansPruned: 0 });
      expect(putAttempts).toBe(1); // still 1 — no second push
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });

  test("reconciles a missed plan push once, then stays idempotent on the next rollup", async () => {
    const { id: owner } = await seedUser("reconcile-usage@example.com");
    await env.DB.prepare("UPDATE users SET plan = 'standard', pending_plan = NULL WHERE id = ?").bind(owner).run();
    await seedVault("reconcile-v", owner);

    // Model a plan-change push that failed earlier: the DO still reports the
    // trial/default entitlement, while D1 now says the owner is standard.
    let resolved = planEntitlement("trial");
    let reads = 0;
    let pushes = 0;
    const pushedBodies: VaultEntitlement[] = [];
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const runDeps: OAuthDeps = {
      ...deps(() => NOW),
      vaultFetch: async (_input, init) => {
        if (init?.method === "GET") {
          reads++;
          return Response.json(splitBody(1234, 56, resolved));
        }
        if (init?.method === "PUT") {
          pushes++;
          const body = JSON.parse(String(init.body)) as VaultEntitlement;
          pushedBodies.push(body);
          resolved = body;
          return Response.json({ ok: true });
        }
        return new Response("method not allowed", { status: 405 });
      },
    };

    try {
      const first = await runUsageRollup(env, runDeps, { onlyVault: "reconcile-v" });
      expect(first).toEqual({ day: TODAY, vaults: 1, recorded: 1, failed: 0, reconciled: 1, capped: false, reconcileCapped: false, orphansPruned: 0 });
      expect(reads).toBe(1);
      expect(pushes).toBe(1);
      expect(pushedBodies).toEqual([planEntitlement("standard")]);

      const second = await runUsageRollup(env, runDeps, { onlyVault: "reconcile-v" });
      expect(second).toEqual({ day: TODAY, vaults: 1, recorded: 1, failed: 0, reconciled: 0, capped: false, reconcileCapped: false, orphansPruned: 0 });
      expect(reads).toBe(2);
      expect(pushes).toBe(1);
      expect(log.mock.calls.filter((c) => String(c[0]).includes("event=entitlement_reconciled")).length).toBe(1);
    } finally {
      log.mockRestore();
    }
  });

  test("reconcile is bounded by the CURRENT paid plan — a stale over-entitled DO is pulled DOWN, never left standing", async () => {
    const { id: owner } = await seedUser("reconcile-downgrade@example.com");
    // The owner downgraded (or was never upgraded past entry), but the DO
    // still resolves power's richer entitlement — e.g. a stale push from
    // before a downgrade, or an operator's manual over-grant. Reconcile must
    // never treat "the DO already has more" as fine; it re-pushes exactly
    // the current plan's entitlement, shrinking caps/voice back down.
    await env.DB.prepare("UPDATE users SET plan = 'entry', pending_plan = NULL WHERE id = ?").bind(owner).run();
    await seedVault("reconcile-down-v", owner);

    let resolved = planEntitlement("power");
    const pushedBodies: VaultEntitlement[] = [];
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const runDeps: OAuthDeps = {
      ...deps(() => NOW),
      vaultFetch: async (_input, init) => {
        if (init?.method === "GET") return Response.json(splitBody(1234, 56, resolved));
        if (init?.method === "PUT") {
          const body = JSON.parse(String(init.body)) as VaultEntitlement;
          pushedBodies.push(body);
          resolved = body;
          return Response.json({ ok: true });
        }
        return new Response("method not allowed", { status: 405 });
      },
    };

    try {
      const summary = await runUsageRollup(env, runDeps, { onlyVault: "reconcile-down-v" });
      expect(summary).toEqual({ day: TODAY, vaults: 1, recorded: 1, failed: 0, reconciled: 1, capped: false, reconcileCapped: false, orphansPruned: 0 });
      // Exactly entry's entitlement — never power's, never something in
      // between (no partial/merged grant).
      expect(pushedBodies).toEqual([planEntitlement("entry")]);
      const entryEnt = planEntitlement("entry");
      const powerEnt = planEntitlement("power");
      expect(pushedBodies[0].caps.notes_bytes + pushedBodies[0].caps.attachment_bytes).toBeLessThan(
        powerEnt.caps.notes_bytes + powerEnt.caps.attachment_bytes,
      );
      expect(pushedBodies[0].transcription.enabled).toBe(entryEnt.transcription.enabled);

      // Idempotent: a second tick against the now-converged DO is a no-op.
      const second = await runUsageRollup(env, runDeps, { onlyVault: "reconcile-down-v" });
      expect(second).toEqual({ day: TODAY, vaults: 1, recorded: 1, failed: 0, reconciled: 0, capped: false, reconcileCapped: false, orphansPruned: 0 });
      expect(pushedBodies).toHaveLength(1);
    } finally {
      log.mockRestore();
    }
  });

  test("D1 — a plan change between the batch snapshot and this vault's turn is never clobbered back down (no downgrade push)", async () => {
    const { id: owner } = await seedUser("race-owner@example.com");
    await env.DB.prepare("UPDATE users SET plan = 'standard', pending_plan = NULL WHERE id = ?").bind(owner).run();
    await seedVault("race-v", owner);

    let getCalls = 0;
    let putCalls = 0;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const runDeps: OAuthDeps = {
      ...deps(() => NOW),
      vaultFetch: async (_input, init) => {
        if (init?.method === "GET") {
          getCalls++;
          if (getCalls === 1) {
            // Model the race: runUsageRollup's batch query already snapshot
            // this owner as 'standard' before this fetch fires. Right here —
            // between that snapshot and this vault's turn in the loop — a
            // concurrent checkout completes AND its own push already landed:
            // the DO genuinely reports 'power', ahead of D1's stale snapshot.
            await env.DB.prepare("UPDATE users SET plan = 'power', pending_plan = NULL WHERE id = ?").bind(owner).run();
          }
          return Response.json(splitBody(1234, 56, planEntitlement("power")));
        }
        if (init?.method === "PUT") {
          putCalls++;
          return Response.json({ ok: true });
        }
        return new Response("method not allowed", { status: 405 });
      },
    };

    try {
      const summary = await runUsageRollup(env, runDeps, { onlyVault: "race-v" });
      // A mismatch WAS detected against the stale snapshot ('standard' !=
      // the DO's 'power'), but the fresh re-read shows the DO already
      // reflects the CURRENT truth — nothing is pushed, and reconciled stays
      // 0 (nothing needed repair).
      expect(summary).toEqual({ day: TODAY, vaults: 1, recorded: 1, failed: 0, reconciled: 0, capped: false, reconcileCapped: false, orphansPruned: 0 });
      expect(putCalls).toBe(0); // never clobbered the DO back down to 'standard'
      expect(
        log.mock.calls.some((c) => String(c[0]).includes("event=entitlement_reconcile_skipped_race vault=race-v")),
      ).toBe(true);

      const row = await env.DB.prepare("SELECT plan FROM users WHERE id = ?").bind(owner).first<{ plan: string }>();
      expect(row?.plan).toBe("power"); // untouched by this rollup
    } finally {
      log.mockRestore();
    }
  });

  test("D1 CORE — the repair PUSHES THE FRESH PLAN, not the stale snapshot, when the owner flips to a THIRD value mid-run", async () => {
    // The D1 race test above proves we don't clobber a DO that ALREADY matches
    // the new truth — but it returns before the push, so it cannot see WHICH
    // entitlement the push carries. Neither can any other reconcile test here:
    // in each of them the snapshot and the fresh re-read are the same plan, so
    // pushing `snapshotExpected` instead of `freshExpected` would pass the
    // entire suite. This is the test that distinguishes them: the snapshot says
    // standard, the DO holds trial (so there IS a real repair to do), and the
    // owner flips to a THIRD value — power — mid-run. Exactly one entitlement
    // is correct to push, and it is neither the snapshot's nor the DO's.
    const { id: owner } = await seedUser("fresh-push@example.com");
    await env.DB.prepare("UPDATE users SET plan = 'standard', pending_plan = NULL WHERE id = ?").bind(owner).run();
    await seedVault("fresh-push-v", owner);

    let getCalls = 0;
    const pushedBodies: VaultEntitlement[] = [];
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const runDeps: OAuthDeps = {
      ...deps(() => NOW),
      vaultFetch: async (_input, init) => {
        if (init?.method === "GET") {
          getCalls++;
          if (getCalls === 1) {
            // After the batch query snapshot ('standard'), before this vault's
            // reconcile: the customer upgrades again, to power.
            await env.DB.prepare("UPDATE users SET plan = 'power', pending_plan = NULL WHERE id = ?").bind(owner).run();
          }
          // The DO is still on trial — a genuinely missed push, so the
          // reconciler will reach the push rather than short-circuiting.
          return Response.json(splitBody(1234, 56, planEntitlement("trial")));
        }
        if (init?.method === "PUT") {
          pushedBodies.push(JSON.parse(String(init.body)) as VaultEntitlement);
          return Response.json({ ok: true });
        }
        return new Response("method not allowed", { status: 405 });
      },
    };

    try {
      const summary = await runUsageRollup(env, runDeps, { onlyVault: "fresh-push-v" });
      expect(summary).toEqual({ day: TODAY, vaults: 1, recorded: 1, failed: 0, reconciled: 1, capped: false, reconcileCapped: false, orphansPruned: 0 });
      expect(pushedBodies).toHaveLength(1);
      // THE ASSERTION: power (the fresh truth), never standard (the snapshot).
      expect(pushedBodies[0]).toEqual(planEntitlement("power"));
      expect(pushedBodies[0]).not.toEqual(planEntitlement("standard"));
      // And the customer is not left short of what they now pay for.
      const powerEnt = planEntitlement("power");
      const standardEnt = planEntitlement("standard");
      expect(pushedBodies[0].caps.notes_bytes + pushedBodies[0].caps.attachment_bytes).toBe(
        powerEnt.caps.notes_bytes + powerEnt.caps.attachment_bytes,
      );
      expect(pushedBodies[0].caps.notes_bytes + pushedBodies[0].caps.attachment_bytes).toBeGreaterThan(
        standardEnt.caps.notes_bytes + standardEnt.caps.attachment_bytes,
      );
    } finally {
      log.mockRestore();
    }
  });

  test("a reconcile-step THROW is attributed to reconciliation, never to the usage fetch (recorded + failed <= vaults holds)", async () => {
    const { id: owner } = await seedUser("reconcile-throw@example.com");
    await env.DB.prepare("UPDATE users SET plan = 'standard', pending_plan = NULL WHERE id = ?").bind(owner).run();
    await seedVault("reconcile-throw-v", owner);

    // Break ONLY the reconcile step's own D1 read (getUserById), leaving the
    // enumeration query and the usage-row INSERT working. Before the split
    // try/catch this threw into the usage-recording catch, counting the vault
    // as recorded AND failed and blaming `usage_fetch_failed` for a D1 call
    // the usage fetch never made.
    const failingDb = new Proxy(env.DB, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (sql.includes("SELECT * FROM users WHERE id")) throw new Error("D1 exploded mid-reconcile");
            return target.prepare(sql);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const runDeps: OAuthDeps = {
      ...deps(() => NOW),
      vaultFetch: async (_input, init) => {
        if (init?.method === "GET") return Response.json(splitBody(777, 33, planEntitlement("trial")));
        return new Response("method not allowed", { status: 405 });
      },
    };

    try {
      const summary = await runUsageRollup({ ...env, DB: failingDb }, runDeps, { onlyVault: "reconcile-throw-v" });
      // recorded stays 1, failed stays 0 — the usage read genuinely succeeded.
      expect(summary).toEqual({ day: TODAY, vaults: 1, recorded: 1, failed: 0, reconciled: 0, capped: false, reconcileCapped: false, orphansPruned: 0 });
      expect(summary.recorded + summary.failed).toBeLessThanOrEqual(summary.vaults);
      // The usage row SURVIVES a reconcile failure.
      expect(await usageRows()).toEqual([
        { vault_name: "reconcile-throw-v", day: TODAY, db_bytes: 777, r2_bytes: 33 },
      ]);
      // Blamed correctly, and NOT on the usage fetch.
      expect(
        errSpy.mock.calls.some((c) =>
          String(c[0]).includes("event=entitlement_reconcile_failed vault=reconcile-throw-v"),
        ),
      ).toBe(true);
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes("event=usage_fetch_failed"))).toBe(false);
    } finally {
      log.mockRestore();
      errSpy.mockRestore();
    }
  });

  test("D2 — an unrecognized raw plan value skips reconcile entirely: zero pushes, never freezes a live vault", async () => {
    const { id: owner } = await seedUser("garbage-plan@example.com");
    // A hand-edited/raw-restored row: 'free' predates the pricing-model
    // rewrite and isn't a current PlanId — migration 0018 documents that
    // users.plan's column DEFAULT is still literally 'free'.
    await env.DB.prepare("UPDATE users SET plan = 'free', pending_plan = NULL WHERE id = ?").bind(owner).run();
    await seedVault("garbage-plan-v", owner);

    let putCalls = 0;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const runDeps: OAuthDeps = {
      ...deps(() => NOW),
      vaultFetch: async (_input, init) => {
        if (init?.method === "GET") return Response.json(splitBody(10, 0, planEntitlement("trial")));
        if (init?.method === "PUT") {
          putCalls++;
          return Response.json({ ok: true });
        }
        return new Response("method not allowed", { status: 405 });
      },
    };

    try {
      const summary = await runUsageRollup(env, runDeps, { onlyVault: "garbage-plan-v" });
      expect(summary).toEqual({ day: TODAY, vaults: 1, recorded: 1, failed: 0, reconciled: 0, capped: false, reconcileCapped: false, orphansPruned: 0 });
      // The trial reading (frozen:false) mismatches what coercePlanId('free')
      // → 'expired' → frozen:true would have expected — the OLD code would
      // have pushed a freeze here. Zero pushes proves the new guard runs
      // BEFORE any entitlement is even computed.
      expect(putCalls).toBe(0);
      expect(
        log.mock.calls.some((c) =>
          String(c[0]).includes("event=entitlement_reconcile_skipped_unknown_plan vault=garbage-plan-v plan=free"),
        ),
      ).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  test("D3 — a vault-worker ROLLBACK (entitlement fields entirely absent) never fails the usage read; reconcile is skipped for that vault only", async () => {
    const { id: owner } = await seedUser("rollback-owner@example.com");
    await seedVault("rollback-v", owner);
    // Shaped like a PRE-entitlement vault worker: the usage split is present,
    // but caps/frozen/transcription_enabled/transcribe_minutes_limit are
    // entirely ABSENT — distinct from the legitimate "unpushed vault" shape
    // (splitBody's default), which still reports all four fields (caps:null).
    interceptConfigGet("rollback-v", {
      name: "x",
      cap_bytes: null,
      resolved_cap_bytes: 1,
      used_bytes: 10,
      db_bytes: 10,
      r2_bytes: 0,
    });

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const summary = await runUsageRollup(env, rollupDeps());
      expect(summary).toEqual({ day: TODAY, vaults: 1, recorded: 1, failed: 0, reconciled: 0, capped: false, reconcileCapped: false, orphansPruned: 0 });
      expect(await usageRows()).toEqual([{ vault_name: "rollback-v", day: TODAY, db_bytes: 10, r2_bytes: 0 }]);
      expect(
        log.mock.calls.some((c) =>
          String(c[0]).includes("event=entitlement_reconcile_skipped_no_entitlement_data vault=rollback-v"),
        ),
      ).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  test("cloud#238 — a present-but-MALFORMED caps degrades to entitlement:null; the good byte split is still recorded", async () => {
    const { id: owner } = await seedUser("malformed-caps@example.com");
    await seedVault("malformed-caps-v", owner);
    // NOT the D3 rollback shape: every control-plane field is PRESENT, but
    // `caps` itself is garbage (a half-deployed vault worker, a hand-edited DO
    // config). `parseResolvedCaps` used to throw out of `readVaultUsage`,
    // which discarded a perfectly good db_bytes/r2_bytes split and wrote NO
    // row — contradicting readVaultUsage's own contract that usage recording
    // never dies from an entitlement problem.
    interceptConfigGet("malformed-caps-v", {
      ...splitBody(4242, 17),
      caps: { notes_bytes: "lots", attachment_bytes: null },
    });

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const summary = await runUsageRollup(env, rollupDeps());
      expect(summary).toEqual({
        day: TODAY,
        vaults: 1,
        recorded: 1,
        failed: 0,
        reconciled: 0,
        capped: false,
        reconcileCapped: false,
        orphansPruned: 0,
      });
      expect(await usageRows()).toEqual([{ vault_name: "malformed-caps-v", day: TODAY, db_bytes: 4242, r2_bytes: 17 }]);
      // Degraded, never believed: an unparseable caps must not read as
      // "converged" (silently hiding an entitlement problem) and must not
      // actuate a push off a DO state we cannot read. Reconciliation is
      // unavailable for this vault this run, and says so distinctly.
      expect(
        warn.mock.calls.some((c) => String(c[0]).includes("event=internal_config_caps_malformed vault=malformed-caps-v")),
      ).toBe(true);
      expect(
        log.mock.calls.some((c) =>
          String(c[0]).includes("event=entitlement_reconcile_skipped_no_entitlement_data vault=malformed-caps-v"),
        ),
      ).toBe(true);
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });

  test("a reconcile push that itself FAILS does not increment reconciled (the next daily tick retries)", async () => {
    const { id: owner } = await seedUser("reconcile-fails@example.com");
    await env.DB.prepare("UPDATE users SET plan = 'standard', pending_plan = NULL WHERE id = ?").bind(owner).run();
    await seedVault("reconcile-fail-v", owner);

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runDeps: OAuthDeps = {
      ...deps(() => NOW),
      vaultFetch: async (_input, init) => {
        if (init?.method === "GET") return Response.json(splitBody(1234, 56, planEntitlement("trial")));
        if (init?.method === "PUT") return new Response("boom", { status: 503 }); // persistently retryable, never heals
        return new Response("method not allowed", { status: 405 });
      },
    };

    try {
      const summary = await runUsageRollup(env, runDeps, { onlyVault: "reconcile-fail-v" });
      expect(summary).toEqual({ day: TODAY, vaults: 1, recorded: 1, failed: 0, reconciled: 0, capped: false, reconcileCapped: false, orphansPruned: 0 });
      expect(
        log.mock.calls.some((c) => String(c[0]).includes("event=entitlement_reconciled vault=reconcile-fail-v ok=false")),
      ).toBe(true);
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
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
    expect(summary).toEqual({ day: TODAY, vaults: 2, recorded: 1, failed: 1, reconciled: 0, capped: false, reconcileCapped: false, orphansPruned: 0 });
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
    expect(summary).toEqual({ day: TODAY, vaults: 2, recorded: 2, failed: 0, reconciled: 0, capped: true, reconcileCapped: false, orphansPruned: 0 });
    expect((await usageRows()).map((r) => r.vault_name)).toEqual(["cap-a", "cap-b"]);
    expect(USAGE_RUN_CAP).toBe(500); // the real bound the cron runs with
  });

  test("cloud#238 — RECONCILE_RUN_CAP bounds PUSHES per run; every vault is still read + recorded", async () => {
    const { id: owner } = await seedUser("reconcile-cap@example.com");
    await env.DB.prepare("UPDATE users SET plan = 'standard', pending_plan = NULL WHERE id = ?").bind(owner).run();
    // Three vaults, ALL mismatching at once — the shape ANY byte-level
    // PLAN_SPECS change produces fleet-wide on the first rollup after deploy,
    // where the push count (not wall-clock) is what approaches Cloudflare's
    // per-invocation subrequest ceiling.
    await seedVault("rcap-a", owner);
    await seedVault("rcap-b", owner);
    await seedVault("rcap-c", owner);

    const pushed: string[] = [];
    let reads = 0;
    const runDeps: OAuthDeps = {
      ...deps(() => NOW),
      vaultFetch: async (input, init) => {
        const vault = new URL(String(input)).hostname.split(".")[0];
        if (init?.method === "GET") {
          reads++;
          return Response.json(splitBody(10, 1, planEntitlement("trial")));
        }
        if (init?.method === "PUT") {
          pushed.push(vault);
          return Response.json({ ok: true });
        }
        return new Response("method not allowed", { status: 405 });
      },
    };

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const summary = await runUsageRollup(env, runDeps, { reconcileCap: 2 });
      expect(summary).toEqual({
        day: TODAY,
        vaults: 3,
        recorded: 3,
        failed: 0,
        reconciled: 2,
        capped: false,
        reconcileCapped: true,
        orphansPruned: 0,
      });
      // The cap bounds REPAIRS, not the rollup: every vault was still read and
      // recorded. Enumeration is ORDER BY name, and a repaired vault matches
      // on the next tick, so the untouched tail is repaired by the following
      // runs rather than starved.
      expect(pushed).toEqual(["rcap-a", "rcap-b"]);
      expect(reads).toBe(3);
      expect((await usageRows()).map((r) => r.vault_name)).toEqual(["rcap-a", "rcap-b", "rcap-c"]);
      expect(err.mock.calls.some((c) => String(c[0]).includes("event=entitlement_reconcile_run_capped cap=2"))).toBe(true);
      expect(RECONCILE_RUN_CAP).toBe(50); // the real bound the cron runs with
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
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
    expect(summary).toEqual({ day: TODAY, vaults: 1, recorded: 1, failed: 0, reconciled: 0, capped: false, reconcileCapped: false, orphansPruned: 0 });
    expect((await usageRows()).map((r) => r.vault_name)).toEqual(["uscope-mine"]);
  });

  test("onlyVault for an unknown name → an empty, clean run (no vault reads)", async () => {
    const summary = await quietly(() => runUsageRollup(env, rollupDeps(), { onlyVault: "does-not-exist" }));
    expect(summary).toEqual({ day: TODAY, vaults: 0, recorded: 0, failed: 0, reconciled: 0, capped: false, reconcileCapped: false, orphansPruned: 0 });
    expect(await usageRows()).toEqual([]);
  });

  // A-1 (migration 0023): a tombstoned owner's vault is excluded from
  // enumeration entirely. No interceptor is registered for it — if the sweep
  // tried to read it anyway, disableNetConnect (beforeAll) would refuse the
  // fetch and this test would fail loudly.
  test("a tombstoned owner's vault is excluded from the rollup — zero vault-worker fetches", async () => {
    const { id: owner } = await seedUser("deleted-usage@example.com");
    await seedVault("deleted-usage-v", owner);
    await env.DB.prepare("UPDATE users SET deleted_at = ? WHERE id = ?").bind(new Date().toISOString(), owner).run();
    const summary = await quietly(() => runUsageRollup(env, rollupDeps()));
    expect(summary).toEqual({ day: TODAY, vaults: 0, recorded: 0, failed: 0, reconciled: 0, capped: false, reconcileCapped: false, orphansPruned: 0 });
    expect(await usageRows()).toEqual([]);
  });

  /** A `vault_usage` row for a vault that may or may not exist in `vaults`. */
  async function seedUsageRow(vault: string, day: string): Promise<void> {
    await env.DB.prepare(
      "INSERT INTO vault_usage (vault_name, day, db_bytes, r2_bytes, transcribe_minutes) VALUES (?, ?, 1, 2, 0)",
    )
      .bind(vault, day)
      .run();
  }

  // cloud#227 — the ORPHAN BACKSTOP, same shape as the snapshot sweep's. The
  // rollup enumerates `vaults` and nothing else, so a deleted vault's daily
  // rows were never revisited: 1,008 orphan `vault_usage` rows at the
  // 2026-07-26 staging reclamation. The delete path already prunes
  // synchronously (vaults.ts `deleteVaultD1Rows`, cloud#226/#241); this catches
  // what it never reached.
  test("prunes orphan `vault_usage` rows whose vault is gone, and reports the count", async () => {
    const { id: owner } = await seedUser("usage-orphan@example.com");
    await seedVault("uorphan-live", owner);
    // Three days of rollup for a vault with no `vaults` row at all.
    await seedUsageRow("uorphan-gone", "2026-06-30");
    await seedUsageRow("uorphan-gone", "2026-07-01");
    await seedUsageRow("uorphan-gone", "2026-07-02");
    interceptConfigGet("uorphan-live", splitBody(4444, 55));

    const summary = await quietly(() => runUsageRollup(env, rollupDeps()));
    // Behaviour first: the three orphan days are gone and only today's live row
    // remains. Then the bookkeeping the summary reports.
    expect(await usageRows()).toEqual([{ vault_name: "uorphan-live", day: TODAY, db_bytes: 4444, r2_bytes: 55 }]);
    expect(summary).toEqual({ day: TODAY, vaults: 1, recorded: 1, failed: 0, reconciled: 0, capped: false, reconcileCapped: false, orphansPruned: 3 });
  });

  // The prune keys on `vaults`, NOT on what the rollup enumerated. A tombstoned
  // owner's vault is skipped by enumeration but still HOLDS its `vaults` row
  // until the storage is actually destroyed, so its usage history is not an
  // orphan and must survive — it is the record of storage that is still billed.
  test("the prune spares a tombstoned owner's vault — its `vaults` row still stands, so it is not an orphan", async () => {
    const { id: owner } = await seedUser("usage-orphan-tombstone@example.com");
    await seedVault("utombstoned-v", owner);
    await seedUsageRow("utombstoned-v", "2026-07-02");
    await env.DB.prepare("UPDATE users SET deleted_at = ? WHERE id = ?").bind(new Date().toISOString(), owner).run();

    // No interceptor: enumeration excludes the vault, and an unexpected fetch
    // would trip disableNetConnect.
    const summary = await quietly(() => runUsageRollup(env, rollupDeps()));
    expect(summary).toEqual({ day: TODAY, vaults: 0, recorded: 0, failed: 0, reconciled: 0, capped: false, reconcileCapped: false, orphansPruned: 0 });
    expect((await usageRows()).map((r) => r.vault_name)).toEqual(["utombstoned-v"]);
  });

  // A scoped run keeps scoped effects — same rationale as the snapshot sweep's
  // onlyVault case (cloud#224/#166): the smoke's O(1) trigger must not carry a
  // fleet-wide DELETE. The nightly USAGE_CRON always runs unscoped.
  test("an onlyVault run does NOT prune — the fleet-wide backstop is the unscoped cron's job", async () => {
    const { id: owner } = await seedUser("usage-scope-noprune@example.com");
    await seedVault("unoprune-mine", owner);
    await seedUsageRow("unoprune-gone", "2026-07-01");
    interceptConfigGet("unoprune-mine", splitBody(7, 8));

    const summary = await quietly(() => runUsageRollup(env, rollupDeps(), { onlyVault: "unoprune-mine" }));
    expect(summary).toEqual({ day: TODAY, vaults: 1, recorded: 1, failed: 0, reconciled: 0, capped: false, reconcileCapped: false, orphansPruned: 0 });
    expect((await usageRows()).map((r) => r.vault_name)).toEqual(["unoprune-gone", "unoprune-mine"]);
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

  test("a recorded vault card reads as TWO meters, each of its own pooled budget (latest row)", async () => {
    const { id: userId } = await seedUser("shows@example.com");
    await seedVault("shows-v", userId);
    await seedRow("shows-v", "2026-07-01", 100_000, 0); // stale — must lose to the newer row
    await seedRow("shows-v", "2026-07-02", 150_000, 59_715);
    const html = await consoleHtml(await seedSession(userId));
    expect(html).toContain('data-testid="vault-usage"');
    // The two meters, split (#107) — notes of the notes pool, attachments of
    // the attachment pool, never the two budgets summed into one denominator.
    expect(html).toContain(vaultUsageLine("trial", 150_000, 59_715));
    // The plan line carries the across-vaults total against that same pool.
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
    await seedRow("two-a", "2026-07-02", 1_048_576, 0); // 1.0 MB notes
    await seedRow("two-b", "2026-07-02", 2_097_152, 1_048_576); // 2.0 MB notes + 1.0 MB attach
    const html = await consoleHtml(await seedSession(userId));
    // Each card carries its OWN per-meter numerators; the DENOMINATORS are the
    // one pooled plan budget both vaults share, which is why the copy says so.
    expect(html).toContain(vaultUsageLine("trial", 1_048_576, 0));
    expect(html).toContain(vaultUsageLine("trial", 2_097_152, 1_048_576));
    expect(html).toMatch(/usage-total[^<]*>&middot; Using 4\.0 MB/);
  });

  test("a power-plan card reads against POWER's per-meter pools (distinct from the trial default's)", async () => {
    const { id: userId } = await seedUser("paid@example.com");
    await env.DB.prepare("UPDATE users SET plan = 'power' WHERE id = ?").bind(userId).run();
    await seedVault("paid-v", userId);
    await seedRow("paid-v", "2026-07-02", 3_221_225_472, 0); // 3 GiB of notes
    const html = await consoleHtml(await seedSession(userId));
    expect(html).toContain(vaultUsageLine("power", 3_221_225_472, 0));
    // The point of the split: 3 GiB of notes is 3x OVER power's 1 GiB notes
    // pool, and the old summed line ("Using 3.0 GB of 51 GiB") hid that.
    expect(PLAN_SPECS.power.notes_bytes).toBeLessThan(3_221_225_472);
    expect(html).not.toContain("Using 3.0 GB of 51 GiB");
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
