/**
 * The nightly GFS snapshot sweep + paid restore (Wave 4e), identity side:
 *   - SNAPSHOT_CRON routing (ops.ts) — the sweep, never health/digest/drip,
 *   - runSnapshotSweep: per-plan retention in the POST body (paid 14/8/12,
 *     free 0/1/0), the mint-seam claims pinned (first-party client, admin
 *     verb, aud-pinned, 60s), the D1 `vault_snapshots` mirror replaced from
 *     the returned manifest, per-vault failure isolation, the run cap,
 *     the cloud#227 orphan prune (fleet-wide only; spares a tombstoned owner's
 *     vault, which still holds its `vaults` row),
 *   - the console History section: paid → restore points + doors + the
 *     attachments caveat; paid-no-rows → "begin within a day"; free → the
 *     teaser (and NEVER a snapshot key — the internal DR artifact stays ours),
 *   - POST /console/vaults/restore: free → 404 (pinned), paid happy path
 *     (creates `<vault>-restored-<date>`, pushes the plan cap, drives the
 *     target DO's internal restore, redirects with the honest notice),
 *     at-cap refusal, ownership, unknown key, CSRF, same-day target reuse,
 *   - the staging-only /__test/snapshot-run trigger (404 in production),
 *   - the plan policy itself (plans.ts) — retention + restore entitlement.
 */
import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import worker from "../src/index.ts";
import app from "../src/index.ts";
import { SNAPSHOT_CRON, handleScheduled, routeCron } from "../src/ops.ts";
import {
  SNAPSHOT_RUN_CAP,
  countStaleSnapshots,
  listSnapshotsForVaults,
  restoredVaultName,
  runSnapshotSweep,
  type SnapshotEntryWire,
} from "../src/snapshots.ts";
import { PLAN_SPECS } from "../src/plans.ts";
import { createVault, getVault } from "../src/vaults.ts";
import { handleOpsSnapshotRunPost } from "../src/ops-daily.ts";
import { validateAccessToken } from "../src/tokens.ts";
import type { OAuthDeps } from "../src/oauth-shared.ts";
import type { EmailSender, SendResult } from "../src/email.ts";
import { CSRF, ISSUER, deps, seedSession, seedUser, seedVault } from "./helpers.ts";

const NOW = new Date("2026-07-03T04:00:00Z");
const TODAY = "2026-07-03";

function sweepDeps(now: () => Date = () => NOW): OAuthDeps {
  return { ...deps(now), vaultOrigin: env.VAULT_ORIGIN };
}

function wireEntry(vault: string, iso: string, extra: Partial<SnapshotEntryWire> = {}): SnapshotEntryWire {
  const ts = iso.replace(/[:.]/g, "-");
  return {
    key: `vault-${vault}/snapshots/${ts}.tar`,
    taken_at: iso,
    bytes: 10_240,
    notes: 6,
    ranks: ["daily"],
    ...extra,
  };
}

/** Intercept POST /vault/<name>/api/internal/snapshot, capturing auth + body. */
function interceptSnapshotPost(
  vault: string,
  reply: { skipped: boolean; manifest: SnapshotEntryWire[] },
  opts: { status?: number; captureAuth?: (a: string | undefined) => void; captureBody?: (b: string) => void } = {},
): void {
  fetchMock
    .get(env.VAULT_ORIGIN!)
    .intercept({
      path: `/vault/${vault}/api/internal/snapshot`,
      method: "POST",
      headers: (h: Record<string, string>) => {
        opts.captureAuth?.(h.authorization ?? h.Authorization);
        return true;
      },
      body: (b: string) => {
        opts.captureBody?.(b);
        return true;
      },
    })
    .reply(opts.status ?? 200, reply, { headers: { "content-type": "application/json" } });
}

/** Intercept the restore flow's two vault calls for a TARGET vault. */
function interceptRestoreFlow(
  target: string,
  opts: { restoreStatus?: number; captureRestoreBody?: (b: string) => void; captureAuth?: (a: string | undefined) => void } = {},
): void {
  // pushVaultCap (best-effort PUT — the restore path pushes the plan cap).
  fetchMock
    .get(env.VAULT_ORIGIN!)
    .intercept({ path: `/vault/${target}/api/internal/config`, method: "PUT" })
    .reply(200, { name: target }, { headers: { "content-type": "application/json" } });
  fetchMock
    .get(env.VAULT_ORIGIN!)
    .intercept({
      path: `/vault/${target}/api/internal/restore`,
      method: "POST",
      headers: (h: Record<string, string>) => {
        opts.captureAuth?.(h.authorization ?? h.Authorization);
        return true;
      },
      body: (b: string) => {
        opts.captureRestoreBody?.(b);
        return true;
      },
    })
    .reply(
      opts.restoreStatus ?? 200,
      { restored: true, stats: { notes_created: 3 } },
      { headers: { "content-type": "application/json" } },
    );
}

/** The vault's answer to the console's "how did the last restore go?" (GET import-status). */
function interceptImportStatus(target: string, body: Record<string, unknown>): void {
  fetchMock
    .get(env.VAULT_ORIGIN!)
    .intercept({ path: `/vault/${target}/api/internal/import-status`, method: "GET" })
    .reply(200, body, { headers: { "content-type": "application/json" } });
}

async function mirrorRows(): Promise<Array<{ vault_name: string; key: string; taken_at: string; bytes: number; ranks: string }>> {
  const res = await env.DB.prepare("SELECT vault_name, key, taken_at, bytes, ranks FROM vault_snapshots ORDER BY vault_name, taken_at").all<{
    vault_name: string;
    key: string;
    taken_at: string;
    bytes: number;
    ranks: string;
  }>();
  return res.results ?? [];
}

async function seedMirrorRow(vault: string, entry: SnapshotEntryWire): Promise<void> {
  await env.DB.prepare("INSERT INTO vault_snapshots (vault_name, key, taken_at, bytes, ranks) VALUES (?, ?, ?, ?, ?)")
    .bind(vault, entry.key, entry.taken_at, entry.bytes, JSON.stringify(entry.ranks))
    .run();
}

function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  return fn().finally(() => {
    err.mockRestore();
    log.mockRestore();
    warn.mockRestore();
  });
}

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

function sessionCookie(sessionId: string): string {
  return `parachute_id_csrf=${CSRF}; parachute_id_session=${sessionId}`;
}

function restoreReq(fields: Record<string, string>, cookie: string): Request {
  return new Request(`${ISSUER}/console/vaults/restore`, {
    method: "POST",
    body: new URLSearchParams({ __csrf: CSRF, ...fields }),
    headers: { "content-type": "application/x-www-form-urlencoded", origin: ISSUER, cookie },
  });
}

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

// --- plan policy (the single source of truth) -----------------------------------

describe("plan snapshot policy (plans.ts)", () => {
  test("paid + trial: 14/8/12 + restore; expired: the internal rolling weekly, NO restore", () => {
    expect(PLAN_SPECS.standard.snapshot_retention).toEqual({ daily: 14, weekly: 8, monthly: 12 });
    expect(PLAN_SPECS.standard.restore).toBe(true);
    expect(PLAN_SPECS.trial.snapshot_retention).toEqual({ daily: 14, weekly: 8, monthly: 12 });
    expect(PLAN_SPECS.trial.restore).toBe(true);
    expect(PLAN_SPECS.expired.snapshot_retention).toEqual({ daily: 0, weekly: 1, monthly: 0 });
    expect(PLAN_SPECS.expired.restore).toBe(false);
  });
});

// --- cron routing ----------------------------------------------------------------

describe("snapshot cron routing", () => {
  test("SNAPSHOT_CRON maps to the sweep; near-misses degrade to the health check", () => {
    expect(SNAPSHOT_CRON).toBe("0 4 * * *");
    expect(routeCron(SNAPSHOT_CRON)).toBe("snapshot");
    expect(routeCron("0 4 * * 1")).toBe("health");
  });

  test("handleScheduled dispatches the snapshot cron to the sweep — no email, no health probe", async () => {
    // Zero vaults → the sweep makes no vault call; a misroute would either
    // email (digest/drip) or consume a fetch interceptor (health). Silence +
    // an empty mirror prove the route.
    const sender = silentSender();
    await quietly(() => handleScheduled(SNAPSHOT_CRON, env, sender));
    expect(sender.sent).toHaveLength(0);
    expect(await mirrorRows()).toEqual([]);
  });
});

// --- stale backups (the daily ops line's count) ------------------------------------

describe("countStaleSnapshots", () => {
  test("flags a missed night (daily policy), a missed week (weekly floor) and a vault never backed up", async () => {
    const at = (iso: string) => wireEntry("x", iso).taken_at;
    const now = new Date("2026-10-30T03:30:00Z"); // the daily line's run
    const { id: live } = await seedUser("stale-live@example.com");
    const { id: floor } = await seedUser("stale-floor@example.com");
    const { id: gone } = await seedUser("stale-gone@example.com");
    await env.DB.prepare("UPDATE users SET plan = 'standard' WHERE id = ?").bind(live).run();
    await env.DB.prepare("UPDATE users SET plan = 'expired' WHERE id = ?").bind(floor).run();
    await env.DB.prepare("UPDATE users SET deleted_at = '2026-10-01T00:00:00Z' WHERE id = ?").bind(gone).run();
    const vault = async (name: string, owner: string, createdAt: string, newest?: string) => {
      await seedVault(name, owner);
      await env.DB.prepare("UPDATE vaults SET created_at = ? WHERE name = ?").bind(createdAt, name).run();
      if (newest) await seedMirrorRow(name, wireEntry(name, at(newest)));
    };
    await vault("st-fresh", live, "2026-07-16T23:04:16Z", "2026-10-29T04:01:00Z"); // last night: ok
    await seedMirrorRow("st-fresh", wireEntry("st-fresh", "2026-08-29T04:01:11.210Z")); // the NEWEST row counts
    await vault("st-missed", live, "2026-07-16T23:04:16Z", "2026-10-28T04:01:00Z"); // one night missed: stale
    await vault("st-never", live, "2026-10-27T12:00:00Z"); // created days ago, no snapshot: stale
    await vault("st-new", live, "2026-10-30T01:00:00Z"); // created tonight: not yet due
    await vault("st-weekly", floor, "2026-07-01T00:00:00Z", "2026-10-26T04:00:00Z"); // this week's weekly: ok
    await vault("st-weekly-old", floor, "2026-07-01T00:00:00Z", "2026-10-19T04:00:00Z"); // 10+ days: stale
    await vault("st-tombstoned", gone, "2026-07-01T00:00:00Z"); // owner deleted: not swept, not counted

    expect(await countStaleSnapshots(env.DB, now, "paid")).toEqual({ stale: 3, vaults: 6 });
    // Open beta lifts the expired floor to the trial's nightly policy, so the
    // weekly vault that had its weekly 3.5 days ago is now overdue too.
    expect(await countStaleSnapshots(env.DB, now, "open_beta")).toEqual({ stale: 4, vaults: 6 });
  });
});

// --- POST /ops/snapshot-run (re-run the stale vaults now) --------------------------

describe("POST /ops/snapshot-run", () => {
  const TOKEN = "ops-run-test-token";
  const call = (e: typeof env, auth?: string) =>
    handleOpsSnapshotRunPost(
      e,
      new Request(`${ISSUER}/ops/snapshot-run`, { method: "POST", headers: auth ? { authorization: auth } : {} }),
      sweepDeps(() => new Date()),
      silentSender(),
    );

  test("unset secret → null (the router 404s); wrong bearer → 401; the read token is not enough", async () => {
    expect(await call(env, `Bearer ${TOKEN}`)).toBeNull();
    const e = { ...env, OPS_RUN_TOKEN: TOKEN, OPS_READ_TOKEN: "read-only" };
    expect((await call(e))!.status).toBe(401);
    expect((await call(e, "Bearer read-only"))!.status).toBe(401);
    expect((await call(e, `Bearer ${TOKEN}x`))!.status).toBe(401);
  });

  test("backs up only the stale vaults, answers counts only, and leaves stale 0", async () => {
    const { id: owner } = await seedUser("opsrun@example.com");
    await env.DB.prepare("UPDATE users SET plan = 'standard' WHERE id = ?").bind(owner).run();
    for (const v of ["opsrun-fresh", "opsrun-stale"]) {
      await seedVault(v, owner);
      await env.DB.prepare("UPDATE vaults SET created_at = '2026-07-16T23:04:16Z' WHERE name = ?").bind(v).run();
    }
    await seedMirrorRow("opsrun-fresh", wireEntry("opsrun-fresh", new Date(Date.now() - 3_600_000).toISOString()));
    await seedMirrorRow("opsrun-stale", wireEntry("opsrun-stale", "2026-08-29T04:01:11.210Z"));
    // Only the stale vault is called (an unexpected call to the fresh one would fail: net connect is off).
    let body = "";
    const fresh = wireEntry("opsrun-stale", new Date().toISOString());
    fetchMock
      .get(env.VAULT_ORIGIN!)
      .intercept({ path: "/vault/opsrun-stale/api/internal/snapshot", method: "POST", body: (b: string) => ((body = b), true) })
      .reply(200, { skipped: false, long_paths: 1, manifest: [fresh] }, { headers: { "content-type": "application/json" } });

    const res = await quietly(() => call({ ...env, OPS_RUN_TOKEN: TOKEN }, `Bearer ${TOKEN}`));
    expect(res!.status).toBe(200);
    const text = await res!.text();
    expect(JSON.parse(text)).toEqual({
      stale_before: 1,
      run: { day: new Date().toISOString().slice(0, 10), vaults: 1, taken: 1, skipped: 0, failed: 0, capped: false, longPaths: 1, orphansPruned: 0 },
      stale_after: 0,
      vaults: 2,
    });
    expect(text).not.toMatch(/opsrun|example\.com/);
    expect(JSON.parse(body)).toEqual({ retention: { daily: 14, weekly: 8, monthly: 12 } });
    expect((await mirrorRows()).filter((r) => r.vault_name === "opsrun-stale").map((r) => r.key)).toEqual([fresh.key]);
  });

  test("a scoped set over 100 names binds only 100 (D1's limit) and reports capped", async () => {
    const names = Array.from({ length: 150 }, (_, i) => `gone-${i}`); // none exist: no vault calls
    const summary = await quietly(() => runSnapshotSweep(env, sweepDeps(), { onlyVaults: names }));
    expect(summary).toMatchObject({ vaults: 0, failed: 0, capped: true });
  });

  test("nothing stale → no vault call, run null", async () => {
    const res = await quietly(() => call({ ...env, OPS_RUN_TOKEN: TOKEN }, `Bearer ${TOKEN}`));
    expect(await res!.json()).toEqual({ stale_before: 0, run: null, stale_after: 0, vaults: 0 });
  });
});

// --- runSnapshotSweep --------------------------------------------------------------

describe("runSnapshotSweep", () => {
  test("sends each owner's PLAN retention and mirrors the returned manifest into D1", async () => {
    const { id: expiredOwner } = await seedUser("sweep-expired@example.com");
    const { id: paidOwner } = await seedUser("sweep-paid@example.com");
    await env.DB.prepare("UPDATE users SET plan = 'expired' WHERE id = ?").bind(expiredOwner).run();
    await env.DB.prepare("UPDATE users SET plan = 'standard' WHERE id = ?").bind(paidOwner).run();
    await seedVault("sweep-a-expired", expiredOwner);
    await seedVault("sweep-b-paid", paidOwner);

    let expiredBody = "";
    let paidBody = "";
    let auth: string | undefined;
    const expiredManifest = [wireEntry("sweep-a-expired", "2026-06-29T04:00:00.000Z", { ranks: ["daily", "weekly"] })];
    const paidManifest = [
      wireEntry("sweep-b-paid", "2026-07-02T04:00:00.000Z"),
      wireEntry("sweep-b-paid", "2026-07-03T04:00:00.000Z", { ranks: ["daily", "monthly"] }),
    ];
    interceptSnapshotPost("sweep-a-expired", { skipped: false, manifest: expiredManifest }, { captureBody: (b) => (expiredBody = b), captureAuth: (a) => (auth = a) });
    interceptSnapshotPost("sweep-b-paid", { skipped: false, manifest: paidManifest }, { captureBody: (b) => (paidBody = b) });

    // REAL clock: the minted 60s token is validated against wall time below.
    const now = new Date();
    const summary = await quietly(() => runSnapshotSweep(env, sweepDeps(() => now)));
    expect(summary).toEqual({
      day: now.toISOString().slice(0, 10),
      vaults: 2,
      taken: 2,
      skipped: 0,
      failed: 0,
      capped: false,
      longPaths: 0,
      orphansPruned: 0,
    });

    // The retention policy in the body IS the owner's plan policy.
    expect(JSON.parse(expiredBody)).toEqual({ retention: { daily: 0, weekly: 1, monthly: 0 } });
    expect(JSON.parse(paidBody)).toEqual({ retention: { daily: 14, weekly: 8, monthly: 12 } });

    // The D1 mirror equals the returned manifests.
    const rows = await mirrorRows();
    expect(rows.map((r) => [r.vault_name, r.key])).toEqual([
      ["sweep-a-expired", expiredManifest[0]!.key],
      ["sweep-b-paid", paidManifest[0]!.key],
      ["sweep-b-paid", paidManifest[1]!.key],
    ]);
    expect(JSON.parse(rows[0]!.ranks)).toEqual(["daily", "weekly"]);

    // The mint-seam contract: first-party client, admin verb, aud-pinned, 60s.
    const token = auth!.replace(/^Bearer /, "");
    const { payload } = await validateAccessToken(env.DB, token, ISSUER);
    expect(payload.aud).toBe("vault.sweep-a-expired");
    expect(payload.scope).toBe("vault:sweep-a-expired:admin");
    expect(payload.client_id).toBe("parachute-console");
    expect(payload.sub).toBe(expiredOwner);
    expect((payload.exp as number) - (payload.iat as number)).toBe(60);
  });

  test("a skipped snapshot (mid-week, any entitled tier) still refreshes the mirror and counts as skipped", async () => {
    const { id: owner } = await seedUser("sweep-skip@example.com");
    await seedVault("sweep-skip-v", owner);
    const manifest = [wireEntry("sweep-skip-v", "2026-06-29T04:00:00.000Z", { ranks: ["daily", "weekly"] })];
    interceptSnapshotPost("sweep-skip-v", { skipped: true, manifest });
    const summary = await quietly(() => runSnapshotSweep(env, sweepDeps()));
    expect(summary.taken).toBe(0);
    expect(summary.skipped).toBe(1);
    expect((await mirrorRows()).map((r) => r.key)).toEqual([manifest[0]!.key]);
  });

  test("a failing vault is skipped + logged; the run continues AND its stale mirror survives", async () => {
    const { id: owner } = await seedUser("sweep-fail@example.com");
    await seedVault("sweep-bad", owner);
    await seedVault("sweep-good", owner);
    // The bad vault has yesterday's mirror row — a failed night must NOT wipe it.
    const stale = wireEntry("sweep-bad", "2026-07-02T04:00:00.000Z");
    await seedMirrorRow("sweep-bad", stale);

    interceptSnapshotPost("sweep-bad", { skipped: false, manifest: [] }, { status: 500 });
    const goodManifest = [wireEntry("sweep-good", "2026-07-03T04:00:00.000Z")];
    interceptSnapshotPost("sweep-good", { skipped: false, manifest: goodManifest });

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const summary = await runSnapshotSweep(env, sweepDeps());
    expect(summary).toEqual({ day: TODAY, vaults: 2, taken: 1, skipped: 0, failed: 1, capped: false, longPaths: 0, orphansPruned: 0 });
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("event=snapshot_failed vault=sweep-bad"))).toBe(true);
    errSpy.mockRestore();
    logSpy.mockRestore();

    const rows = await mirrorRows();
    expect(rows.map((r) => [r.vault_name, r.key])).toEqual([
      ["sweep-bad", stale.key], // untouched by the failure
      ["sweep-good", goodManifest[0]!.key],
    ]);
  });

  test("a failed vault backup pages the operator once per run — counts only, no vault name", async () => {
    const { id: owner } = await seedUser("sweep-alert@example.com");
    await seedVault("sweep-alert-bad", owner);
    await seedVault("sweep-alert-good", owner);
    interceptSnapshotPost("sweep-alert-bad", { skipped: false, manifest: [] }, { status: 500 });
    interceptSnapshotPost("sweep-alert-good", { skipped: false, manifest: [wireEntry("sweep-alert-good", "2026-07-03T04:00:00.000Z")] });
    const sender = silentSender();
    const opsEnv = { ...env, OPERATOR_ALERT_EMAIL: "ops@example.com", OPS_ALERT_WEBHOOK_URL: undefined };
    const summary = await quietly(() => runSnapshotSweep(opsEnv, sweepDeps(), { sender }));
    expect(summary.failed).toBe(1);
    const mails = sender.sent as Array<{ to: string; subject: string; text: string }>;
    expect(mails).toHaveLength(1);
    expect(mails[0]!.to).toBe("ops@example.com");
    expect(mails[0]!.subject).toBe(`[parachute-cloud test] 1 of 2 vault backups failed (${TODAY})`);
    expect(mails[0]!.text).toContain("event=snapshot_failed");
    expect(`${mails[0]!.subject}\n${mails[0]!.text}`).not.toMatch(/sweep-alert|example\.com/);

    // A clean night sends nothing.
    interceptSnapshotPost("sweep-alert-bad", { skipped: false, manifest: [] });
    interceptSnapshotPost("sweep-alert-good", { skipped: false, manifest: [] });
    const clean = silentSender();
    await quietly(() => runSnapshotSweep(opsEnv, sweepDeps(), { sender: clean }));
    expect(clean.sent).toHaveLength(0);
  });

  test("a 200 body without the run shape counts as a failure (stale vault worker)", async () => {
    const { id: owner } = await seedUser("sweep-stale@example.com");
    await seedVault("sweep-stale-v", owner);
    fetchMock
      .get(env.VAULT_ORIGIN!)
      .intercept({ path: "/vault/sweep-stale-v/api/internal/snapshot", method: "POST" })
      .reply(200, { unexpected: true }, { headers: { "content-type": "application/json" } });
    const summary = await quietly(() => runSnapshotSweep(env, sweepDeps()));
    expect(summary.failed).toBe(1);
    expect(summary.taken).toBe(0);
  });

  test("the per-run cap bounds a sweep and marks it capped", async () => {
    const { id: owner } = await seedUser("sweep-cap@example.com");
    await seedVault("swcap-a", owner);
    await seedVault("swcap-b", owner);
    await seedVault("swcap-c", owner);
    interceptSnapshotPost("swcap-a", { skipped: false, manifest: [] });
    interceptSnapshotPost("swcap-b", { skipped: false, manifest: [] });
    const summary = await quietly(() => runSnapshotSweep(env, sweepDeps(), { runCap: 2 }));
    expect(summary).toEqual({ day: TODAY, vaults: 2, taken: 2, skipped: 0, failed: 0, capped: true, longPaths: 0, orphansPruned: 0 });
    expect(SNAPSHOT_RUN_CAP).toBe(500);
  });

  test("onlyVault scopes the run to a SINGLE vault — the rest of the fleet is untouched (O(1), not O(fleet))", async () => {
    const { id: owner } = await seedUser("sweep-scope@example.com");
    await env.DB.prepare("UPDATE users SET plan = 'standard' WHERE id = ?").bind(owner).run();
    await seedVault("scope-mine", owner);
    await seedVault("scope-other", owner);
    // ONLY the scoped vault's DO is intercepted. The other vault must not be
    // called at all — an unexpected call would trip disableNetConnect, and
    // assertNoPendingInterceptors (afterEach) proves the scoped interceptor was
    // the sole fetch.
    const manifest = [wireEntry("scope-mine", "2026-07-03T04:00:00.000Z")];
    interceptSnapshotPost("scope-mine", { skipped: false, manifest });

    const summary = await quietly(() => runSnapshotSweep(env, sweepDeps(), { onlyVault: "scope-mine" }));
    expect(summary).toEqual({ day: TODAY, vaults: 1, taken: 1, skipped: 0, failed: 0, capped: false, longPaths: 0, orphansPruned: 0 });
    // Only the scoped vault's mirror row exists — scope-other was never swept.
    expect((await mirrorRows()).map((r) => r.vault_name)).toEqual(["scope-mine"]);
  });

  test("onlyVault for an unknown name → an empty, clean run (no vault calls)", async () => {
    const summary = await quietly(() => runSnapshotSweep(env, sweepDeps(), { onlyVault: "does-not-exist" }));
    expect(summary).toEqual({ day: TODAY, vaults: 0, taken: 0, skipped: 0, failed: 0, capped: false, longPaths: 0, orphansPruned: 0 });
    expect(await mirrorRows()).toEqual([]);
  });

  // A-1 (migration 0023): a tombstoned owner's vault is excluded from
  // enumeration entirely. No interceptor is registered for it — if the sweep
  // tried to snapshot it anyway, disableNetConnect would refuse the fetch and
  // this test would fail loudly.
  test("a tombstoned owner's vault is excluded from the sweep — zero vault-worker fetches", async () => {
    const { id: owner } = await seedUser("deleted-snapshot@example.com");
    await seedVault("deleted-snapshot-v", owner);
    await env.DB.prepare("UPDATE users SET deleted_at = ? WHERE id = ?").bind(new Date().toISOString(), owner).run();
    const summary = await quietly(() => runSnapshotSweep(env, sweepDeps()));
    expect(summary).toEqual({ day: TODAY, vaults: 0, taken: 0, skipped: 0, failed: 0, capped: false, longPaths: 0, orphansPruned: 0 });
    expect(await mirrorRows()).toEqual([]);
  });

  // cloud#227 — the ORPHAN BACKSTOP. The sweep enumerates `vaults` and nothing
  // else, so a deleted vault's mirror rows were never revisited: they simply
  // accumulated (1,524 orphan `vault_snapshots` rows at the 2026-07-26 staging
  // reclamation). The delete path already prunes synchronously
  // (vaults.ts `deleteVaultD1Rows`, cloud#226/#241); this is the backstop for
  // whatever that path never reached — a crash between the DO destroy and the
  // D1 batch, a hand-deleted row, pre-fix debris.
  test("prunes orphan `vault_snapshots` rows whose vault is gone, and reports the count", async () => {
    const { id: owner } = await seedUser("sweep-orphan@example.com");
    await seedVault("orphan-live", owner);
    // Two mirror rows for a vault with no `vaults` row at all.
    await seedMirrorRow("orphan-gone", wireEntry("orphan-gone", "2026-07-01T04:00:00.000Z"));
    await seedMirrorRow("orphan-gone", wireEntry("orphan-gone", "2026-07-02T04:00:00.000Z"));
    const manifest = [wireEntry("orphan-live", "2026-07-03T04:00:00.000Z")];
    interceptSnapshotPost("orphan-live", { skipped: false, manifest });

    const summary = await quietly(() => runSnapshotSweep(env, sweepDeps()));
    // Behaviour first: only the orphans went — the live vault's fresh mirror
    // row stands. Then the bookkeeping the summary reports.
    expect((await mirrorRows()).map((r) => [r.vault_name, r.key])).toEqual([["orphan-live", manifest[0]!.key]]);
    expect(summary).toEqual({ day: TODAY, vaults: 1, taken: 1, skipped: 0, failed: 0, capped: false, longPaths: 0, orphansPruned: 2 });
  });

  // The prune keys on `vaults`, NOT on what the sweep enumerated. A tombstoned
  // owner's vault is skipped by enumeration but still HOLDS its `vaults` row
  // (deleteVaultD1Rows drops it only once the storage is actually destroyed),
  // so its mirror is not an orphan and must survive. Deleting it here would
  // hide still-billed storage from the console — the exact failure the
  // account-delete note guards against.
  test("the prune spares a tombstoned owner's vault — its `vaults` row still stands, so it is not an orphan", async () => {
    const { id: owner } = await seedUser("sweep-orphan-tombstone@example.com");
    await seedVault("tombstoned-mirror-v", owner);
    const kept = wireEntry("tombstoned-mirror-v", "2026-07-02T04:00:00.000Z");
    await seedMirrorRow("tombstoned-mirror-v", kept);
    await env.DB.prepare("UPDATE users SET deleted_at = ? WHERE id = ?").bind(new Date().toISOString(), owner).run();

    // No interceptor: enumeration excludes the vault, and an unexpected fetch
    // would trip disableNetConnect.
    const summary = await quietly(() => runSnapshotSweep(env, sweepDeps()));
    expect(summary).toEqual({ day: TODAY, vaults: 0, taken: 0, skipped: 0, failed: 0, capped: false, longPaths: 0, orphansPruned: 0 });
    expect((await mirrorRows()).map((r) => r.key)).toEqual([kept.key]);
  });

  // A scoped run keeps scoped effects. `onlyVault` exists so the live smoke's
  // trigger is O(1) and touches exactly the vault it names (cloud#166/#218);
  // a fleet-wide DELETE behind it would be a blast radius the trigger does not
  // advertise. The nightly cron always runs unscoped — that is the backstop's
  // home.
  test("an onlyVault run does NOT prune — the fleet-wide backstop is the unscoped cron's job", async () => {
    const { id: owner } = await seedUser("sweep-scope-noprune@example.com");
    await seedVault("noprune-mine", owner);
    const orphan = wireEntry("noprune-gone", "2026-07-01T04:00:00.000Z");
    await seedMirrorRow("noprune-gone", orphan);
    const manifest = [wireEntry("noprune-mine", "2026-07-03T04:00:00.000Z")];
    interceptSnapshotPost("noprune-mine", { skipped: false, manifest });

    const summary = await quietly(() => runSnapshotSweep(env, sweepDeps(), { onlyVault: "noprune-mine" }));
    expect(summary).toEqual({ day: TODAY, vaults: 1, taken: 1, skipped: 0, failed: 0, capped: false, longPaths: 0, orphansPruned: 0 });
    expect((await mirrorRows()).map((r) => r.vault_name)).toEqual(["noprune-gone", "noprune-mine"]);
  });
});

// --- listSnapshotsForVaults ---------------------------------------------------------

describe("listSnapshotsForVaults", () => {
  test("returns rows newest-first per vault; unrecorded vaults absent; corrupt ranks degrade", async () => {
    await seedMirrorRow("ls-a", wireEntry("ls-a", "2026-07-01T04:00:00.000Z"));
    await seedMirrorRow("ls-a", wireEntry("ls-a", "2026-07-03T04:00:00.000Z", { ranks: ["daily", "monthly"] }));
    await env.DB.prepare("INSERT INTO vault_snapshots (vault_name, key, taken_at, bytes, ranks) VALUES (?, ?, ?, ?, ?)")
      .bind("ls-b", "vault-ls-b/snapshots/x.tar", "2026-07-02T04:00:00.000Z", 5, "not json")
      .run();
    const map = await listSnapshotsForVaults(env.DB, ["ls-a", "ls-b", "ls-none"]);
    expect(map.get("ls-a")!.map((r) => r.takenAt)).toEqual(["2026-07-03T04:00:00.000Z", "2026-07-01T04:00:00.000Z"]);
    expect(map.get("ls-a")![0]!.ranks).toEqual(["daily", "monthly"]);
    expect(map.get("ls-b")![0]!.ranks).toEqual([]); // corrupt → no chip, no crash
    expect(map.has("ls-none")).toBe(false);
    expect((await listSnapshotsForVaults(env.DB, [])).size).toBe(0);
  });
});

// --- restoredVaultName ----------------------------------------------------------------

describe("restoredVaultName", () => {
  test("derives <vault>-restored-<date>, truncating to the 63-char slug", () => {
    expect(restoredVaultName("field-notes", NOW)).toBe("field-notes-restored-2026-07-03");
    const long = "a".repeat(60);
    const name = restoredVaultName(long, NOW);
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name.endsWith("-restored-2026-07-03")).toBe(true);
    expect(name).not.toContain("--restored"); // trailing hyphens trimmed off the base
  });

  test("the nth same-day restore gets -n, still within 63 chars", () => {
    expect(restoredVaultName("field-notes", NOW, 1)).toBe("field-notes-restored-2026-07-03");
    expect(restoredVaultName("field-notes", NOW, 3)).toBe("field-notes-restored-2026-07-03-3");
    const name = restoredVaultName("a".repeat(63), NOW, 12);
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name.endsWith("-restored-2026-07-03-12")).toBe(true);
  });
});

// --- the console History section ------------------------------------------------------

describe("console History", () => {
  async function consoleHtml(sessionId: string): Promise<string> {
    const res = await worker.fetch(new Request(`${ISSUER}/console`, { headers: { cookie: sessionCookie(sessionId) } }), env);
    expect(res.status).toBe(200);
    return res.text();
  }

  test("paid: restore points render with human dates, sizes, ranks, restore doors, and the attachments caveat", async () => {
    const { id: userId } = await seedUser("hist-paid@example.com");
    await env.DB.prepare("UPDATE users SET plan = 'standard' WHERE id = ?").bind(userId).run();
    await seedVault("hist-v", userId);
    const entry = wireEntry("hist-v", "2026-07-03T04:00:12.345Z", { bytes: 2 * 1024 * 1024, ranks: ["daily", "weekly"] });
    await seedMirrorRow("hist-v", entry);

    const html = await consoleHtml(await seedSession(userId));
    expect(html).toContain('data-testid="vault-history"');
    expect(html).toContain('data-testid="restore-point"');
    expect(html).toContain("2026-07-03 04:00 UTC");
    expect(html).toContain("2.0 MB");
    expect(html).toContain("weekly"); // the top rank label
    expect(html).toContain(`value="${entry.key}"`); // the restore form's key
    expect(html).toContain('action="/console/vaults/restore"');
    expect(html).toContain("Restore to a new vault");
    // The standing caveats: never touches this vault + no attachment binaries.
    expect(html).toContain("Restoring never touches this vault");
    expect(html).toContain("don't include attachment files");
  });

  test('paid with no rows yet → "snapshots begin within a day"', async () => {
    const { id: userId } = await seedUser("hist-fresh@example.com");
    await env.DB.prepare("UPDATE users SET plan = 'standard' WHERE id = ?").bind(userId).run();
    await seedVault("hist-fresh-v", userId);
    const html = await consoleHtml(await seedSession(userId));
    expect(html).toContain('data-testid="vault-history"');
    expect(html).toContain("Nightly snapshots begin within a day");
    expect(html).not.toContain('data-testid="restore-point"');
  });

  test("expired: the teaser renders and the internal DR snapshot NEVER leaks (no key, no restore door)", async () => {
    const { id: userId } = await seedUser("hist-expired@example.com");
    await env.DB.prepare("UPDATE users SET plan = 'expired' WHERE id = ?").bind(userId).run();
    await seedVault("hist-expired-v", userId);
    // The expired vault DOES have an internal rolling weekly in the mirror.
    const entry = wireEntry("hist-expired-v", "2026-06-29T04:00:00.000Z", { ranks: ["daily", "weekly"] });
    await seedMirrorRow("hist-expired-v", entry);

    const html = await consoleHtml(await seedSession(userId));
    expect(html).toContain('data-testid="vault-history"');
    expect(html).toContain('data-testid="history-teaser"');
    expect(html).toContain("come with the Parachute plan"); // static marketing copy, unchanged in ui.ts
    expect(html).not.toContain(entry.key); // ours, never surfaced
    expect(html).not.toContain('data-testid="restore-point"');
    expect(html).not.toContain("Restore to a new vault");
  });
});

// --- POST /console/vaults/restore -------------------------------------------------------

describe("restore POST", () => {
  test("expired plan → the router-shaped 404, even with a valid session + key (pinned)", async () => {
    const { id: userId } = await seedUser("rp-expired@example.com");
    await env.DB.prepare("UPDATE users SET plan = 'expired' WHERE id = ?").bind(userId).run();
    await seedVault("rp-expired-v", userId);
    const entry = wireEntry("rp-expired-v", "2026-06-29T04:00:00.000Z");
    await seedMirrorRow("rp-expired-v", entry);
    const res = await app.fetch(
      restoreReq({ vault: "rp-expired-v", key: entry.key }, sessionCookie(await seedSession(userId))),
      env,
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("404 Not Found");
  });

  test("paid happy path: creates <vault>-restored-<date>, pushes the cap, drives the DO restore, redirects", async () => {
    const { id: userId } = await seedUser("rp-paid@example.com");
    await env.DB.prepare("UPDATE users SET plan = 'standard' WHERE id = ?").bind(userId).run();
    await seedVault("rp-v", userId);
    const entry = wireEntry("rp-v", "2026-07-02T04:00:00.000Z");
    await seedMirrorRow("rp-v", entry);

    const target = restoredVaultName("rp-v", new Date());
    let restoreBody = "";
    let auth: string | undefined;
    interceptRestoreFlow(target, { captureRestoreBody: (b) => (restoreBody = b), captureAuth: (a) => (auth = a) });

    const res = await quietly(async () =>
      app.fetch(restoreReq({ vault: "rp-v", key: entry.key }, sessionCookie(await seedSession(userId))), env),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/console?restored=${encodeURIComponent(target)}`);

    // The new vault row exists and is owned by the user.
    const row = await env.DB.prepare("SELECT owner_user_id FROM vaults WHERE name = ?").bind(target).first<{ owner_user_id: string }>();
    expect(row?.owner_user_id).toBe(userId);

    // The DO call carried the source + key, on a first-party admin token for
    // the TARGET vault.
    expect(JSON.parse(restoreBody)).toEqual({ source_vault: "rp-v", snapshot_key: entry.key });
    const { payload } = await validateAccessToken(env.DB, auth!.replace(/^Bearer /, ""), ISSUER);
    expect(payload.aud).toBe(`vault.${target}`);
    expect(payload.scope).toBe(`vault:${target}:admin`);
    expect(payload.client_id).toBe("parachute-console");

    // The success notice (with the attachments caveat) renders for the owner.
    const conRes = await worker.fetch(
      new Request(`${ISSUER}/console?restored=${encodeURIComponent(target)}`, {
        headers: { cookie: sessionCookie(await seedSession(userId)) },
      }),
      env,
    );
    const html = await conRes.text();
    expect(html).toContain(`Snapshot restored into &quot;${target}&quot;`);
    expect(html).toContain("the original is untouched");
    expect(html).toContain("don&#39;t include attachment files");
  });

  test("a second same-day restore after one that SUCCEEDED makes <target>-2 and never replays into the first", async () => {
    // The first restored vault is the owner's now: they may have written to
    // it since. Replaying (blow-away) into it again would wipe that.
    const { id: userId } = await seedUser("rp-again@example.com");
    await env.DB.prepare("UPDATE users SET plan = 'standard' WHERE id = ?").bind(userId).run();
    await seedVault("rp-again-v", userId);
    const entry = wireEntry("rp-again-v", "2026-07-02T04:00:00.000Z");
    await seedMirrorRow("rp-again-v", entry);

    const target = restoredVaultName("rp-again-v", new Date());
    const second = restoredVaultName("rp-again-v", new Date(), 2);
    expect(second).toBe(`${target}-2`);
    interceptRestoreFlow(target);
    const cookie = sessionCookie(await seedSession(userId));
    const first = await quietly(async () => app.fetch(restoreReq({ vault: "rp-again-v", key: entry.key }, cookie), env));
    expect(first.status).toBe(302);

    // Only the -2 vault's create + restore are intercepted: a restore POST
    // into the first target would be an unmatched request and fail the test.
    interceptRestoreFlow(second);
    const again = await quietly(async () => app.fetch(restoreReq({ vault: "rp-again-v", key: entry.key }, cookie), env));
    expect(again.status).toBe(302);
    expect(again.headers.get("location")).toBe(`/console?restored=${encodeURIComponent(second)}`);

    const rows = await env.DB.prepare("SELECT name, import_pending_at FROM vaults WHERE name IN (?, ?) ORDER BY name")
      .bind(target, second)
      .all<{ name: string; import_pending_at: string | null }>();
    // Both are finished restores: neither may be reused by a later restore.
    expect(rows.results).toEqual([
      { name: target, import_pending_at: null },
      { name: second, import_pending_at: null },
    ]);
  });

  test("a retry after a FAILED restore reuses its target (no second slot burned, no duplicate row)", async () => {
    const { id: userId } = await seedUser("rp-retry@example.com");
    await env.DB.prepare("UPDATE users SET plan = 'standard' WHERE id = ?").bind(userId).run();
    await seedVault("rp-retry-v", userId);
    const entry = wireEntry("rp-retry-v", "2026-07-02T04:00:00.000Z");
    await seedMirrorRow("rp-retry-v", entry);

    const target = restoredVaultName("rp-retry-v", new Date());
    interceptRestoreFlow(target, { restoreStatus: 500 });
    const cookie = sessionCookie(await seedSession(userId));
    const failed = await quietly(async () => app.fetch(restoreReq({ vault: "rp-retry-v", key: entry.key }, cookie), env));
    expect(await failed.text()).toContain("Restore didn&#39;t complete");

    // The retry asks the vault how that attempt ended, then only the restore
    // POST fires (no create, no second cap push).
    interceptImportStatus(target, { state: "failed", kind: "restore", error_type: "restore_failed" });
    fetchMock
      .get(env.VAULT_ORIGIN!)
      .intercept({ path: `/vault/${target}/api/internal/restore`, method: "POST" })
      .reply(200, { restored: true }, { headers: { "content-type": "application/json" } });
    const retry = await quietly(async () => app.fetch(restoreReq({ vault: "rp-retry-v", key: entry.key }, cookie), env));
    expect(retry.status).toBe(302);
    expect(retry.headers.get("location")).toBe(`/console?restored=${encodeURIComponent(target)}`);

    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM vaults WHERE name LIKE ?").bind(`${target}%`).first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  test("a same-day restore never replays into a pre-existing restored vault that has no retry flag", async () => {
    // A target made before restores carried the flag (or by any other door)
    // is a real vault: treat it as finished.
    const { id: userId } = await seedUser("rp-legacy@example.com");
    await env.DB.prepare("UPDATE users SET plan = 'standard' WHERE id = ?").bind(userId).run();
    await seedVault("rp-legacy-v", userId);
    const entry = wireEntry("rp-legacy-v", "2026-07-02T04:00:00.000Z");
    await seedMirrorRow("rp-legacy-v", entry);
    const target = restoredVaultName("rp-legacy-v", new Date());
    await seedVault(target, userId);

    interceptRestoreFlow(`${target}-2`);
    const res = await quietly(async () =>
      app.fetch(restoreReq({ vault: "rp-legacy-v", key: entry.key }, sessionCookie(await seedSession(userId))), env),
    );
    expect(res.headers.get("location")).toBe(`/console?restored=${encodeURIComponent(`${target}-2`)}`);
  });

  test("a restore-flagged target whose restore actually FINISHED (flag clear lost) is never replayed into", async () => {
    // The flag outlives a finished restore when its clear fails, or when the
    // answer was lost after the vault committed. The vault's own record says
    // the restore landed: the owner may have written to it since.
    const { id: userId } = await seedUser("rp-stale@example.com");
    await env.DB.prepare("UPDATE users SET plan = 'standard' WHERE id = ?").bind(userId).run();
    await seedVault("rp-stale-v", userId);
    const entry = wireEntry("rp-stale-v", "2026-07-02T04:00:00.000Z");
    await seedMirrorRow("rp-stale-v", entry);
    const target = restoredVaultName("rp-stale-v", new Date());
    await createVault(env.DB, target, userId, new Date(), { pending: "restore" });

    interceptImportStatus(target, { state: "done", kind: "restore", notes: 3 });
    interceptRestoreFlow(`${target}-2`);
    const res = await quietly(async () =>
      app.fetch(restoreReq({ vault: "rp-stale-v", key: entry.key }, sessionCookie(await seedSession(userId))), env),
    );
    expect(res.headers.get("location")).toBe(`/console?restored=${encodeURIComponent(`${target}-2`)}`);
    // And the stale flag is gone, so the next restore doesn't have to ask.
    expect((await getVault(env.DB, target))?.importPendingAt).toBeNull();
  });

  test("a double-submitted restore goes to the same target, where the vault's lock refuses it (no second vault)", async () => {
    const { id: userId } = await seedUser("rp-double@example.com");
    await env.DB.prepare("UPDATE users SET plan = 'standard' WHERE id = ?").bind(userId).run();
    await seedVault("rp-double-v", userId);
    const entry = wireEntry("rp-double-v", "2026-07-02T04:00:00.000Z");
    await seedMirrorRow("rp-double-v", entry);
    const target = restoredVaultName("rp-double-v", new Date());
    await createVault(env.DB, target, userId, new Date(), { pending: "restore" });

    interceptImportStatus(target, { state: "running", kind: "restore" });
    fetchMock
      .get(env.VAULT_ORIGIN!)
      .intercept({ path: `/vault/${target}/api/internal/restore`, method: "POST" })
      .reply(503, { error_type: "import_in_progress" }, { headers: { "content-type": "application/json" } });
    const res = await quietly(async () =>
      app.fetch(restoreReq({ vault: "rp-double-v", key: entry.key }, sessionCookie(await seedSession(userId))), env),
    );
    expect(await res.text()).toContain("Restore didn&#39;t complete");
    expect(await getVault(env.DB, `${target}-2`)).toBeNull();
  });

  test("a restore-flagged target the vault can't report on is left alone (no replay into it)", async () => {
    const { id: userId } = await seedUser("rp-unknown@example.com");
    await env.DB.prepare("UPDATE users SET plan = 'standard' WHERE id = ?").bind(userId).run();
    await seedVault("rp-unknown-v", userId);
    const entry = wireEntry("rp-unknown-v", "2026-07-02T04:00:00.000Z");
    await seedMirrorRow("rp-unknown-v", entry);
    const target = restoredVaultName("rp-unknown-v", new Date());
    await createVault(env.DB, target, userId, new Date(), { pending: "restore" });

    fetchMock
      .get(env.VAULT_ORIGIN!)
      .intercept({ path: `/vault/${target}/api/internal/import-status`, method: "GET" })
      .reply(500, "boom");
    interceptRestoreFlow(`${target}-2`);
    const res = await quietly(async () =>
      app.fetch(restoreReq({ vault: "rp-unknown-v", key: entry.key }, sessionCookie(await seedSession(userId))), env),
    );
    expect(res.headers.get("location")).toBe(`/console?restored=${encodeURIComponent(`${target}-2`)}`);
  });

  test("a restore never replays into an unfinished IMPORT that happens to hold the restore name", async () => {
    // The import door's retry flag means "an upload of the owner's that didn't
    // finish", not "a restore that didn't finish": its content is not this
    // snapshot, so blow-away replaying into it would lose it.
    const { id: userId } = await seedUser("rp-xdoor@example.com");
    await env.DB.prepare("UPDATE users SET plan = 'standard' WHERE id = ?").bind(userId).run();
    await seedVault("rp-xdoor-v", userId);
    const entry = wireEntry("rp-xdoor-v", "2026-07-02T04:00:00.000Z");
    await seedMirrorRow("rp-xdoor-v", entry);
    const target = restoredVaultName("rp-xdoor-v", new Date());
    await seedVault(target, userId);
    await env.DB.prepare("UPDATE vaults SET import_pending_at = created_at WHERE name = ?").bind(target).run();

    interceptRestoreFlow(`${target}-2`);
    const res = await quietly(async () =>
      app.fetch(restoreReq({ vault: "rp-xdoor-v", key: entry.key }, sessionCookie(await seedSession(userId))), env),
    );
    expect(res.headers.get("location")).toBe(`/console?restored=${encodeURIComponent(`${target}-2`)}`);
  });

  test("the import door refuses an unfinished RESTORE target — an upload never blows it away", async () => {
    const { id: userId } = await seedUser("rp-xdoor2@example.com");
    await env.DB.prepare("UPDATE users SET plan = 'standard' WHERE id = ?").bind(userId).run();
    await seedVault("rp-xdoor2-v", userId);
    const entry = wireEntry("rp-xdoor2-v", "2026-07-02T04:00:00.000Z");
    await seedMirrorRow("rp-xdoor2-v", entry);
    const target = restoredVaultName("rp-xdoor2-v", new Date());
    interceptRestoreFlow(target, { restoreStatus: 500 });
    const cookie = sessionCookie(await seedSession(userId));
    const failed = await quietly(async () => app.fetch(restoreReq({ vault: "rp-xdoor2-v", key: entry.key }, cookie), env));
    expect(await failed.text()).toContain("Restore didn&#39;t complete");

    // No vault interceptor is registered: a forward of the upload would be an
    // unmatched request (and the console would answer "didn't finish").
    const fd = new FormData();
    fd.set("__csrf", CSRF);
    fd.set("vault_name", target);
    fd.set("tarball", new File([new Uint8Array([1, 2, 3])], "export.tar", { type: "application/x-tar" }));
    const res = await quietly(async () =>
      app.fetch(new Request(`${ISSUER}/console/vaults/import`, { method: "POST", body: fd, headers: { origin: ISSUER, cookie } }), env),
    );
    expect(await res.text()).toContain("already taken");
  });

  test("at the plan's vault cap → the friendly refusal; NO vault created, NO DO call", async () => {
    const { id: userId } = await seedUser("rp-cap@example.com");
    await env.DB.prepare("UPDATE users SET plan = 'plus' WHERE id = ?").bind(userId).run();
    // Fill all 5 Plus-tier slots.
    for (let i = 0; i < 5; i++) await seedVault(`rp-cap-${i}`, userId);
    const entry = wireEntry("rp-cap-0", "2026-07-02T04:00:00.000Z");
    await seedMirrorRow("rp-cap-0", entry);

    const res = await app.fetch(restoreReq({ vault: "rp-cap-0", key: entry.key }, sessionCookie(await seedSession(userId))), env);
    expect(res.status).toBe(200); // the console re-render with the error
    const html = await res.text();
    expect(html).toContain("Restoring creates a new vault");
    expect(html).toContain("5-vault limit");
    const target = restoredVaultName("rp-cap-0", new Date());
    const row = await env.DB.prepare("SELECT 1 AS one FROM vaults WHERE name = ?").bind(target).first();
    expect(row).toBeNull();
    // No interceptors were registered — assertNoPendingInterceptors (afterEach)
    // + disableNetConnect prove no vault call was attempted.
  });

  test("a vault the user doesn't own / an unknown key / a foreign-prefix key are all refused", async () => {
    const { id: userId } = await seedUser("rp-guard@example.com");
    const { id: other } = await seedUser("rp-guard-other@example.com");
    await env.DB.prepare("UPDATE users SET plan = 'standard' WHERE id IN (?, ?)").bind(userId, other).run();
    await seedVault("rp-mine", userId);
    await seedVault("rp-theirs", other);
    const mine = wireEntry("rp-mine", "2026-07-02T04:00:00.000Z");
    const theirs = wireEntry("rp-theirs", "2026-07-02T04:00:00.000Z");
    await seedMirrorRow("rp-mine", mine);
    await seedMirrorRow("rp-theirs", theirs);
    const cookie = sessionCookie(await seedSession(userId));

    // Not my vault.
    const foreign = await app.fetch(restoreReq({ vault: "rp-theirs", key: theirs.key }, cookie), env);
    expect(await foreign.text()).toContain("You can only restore a vault you own.");
    // My vault, unknown key.
    const unknown = await app.fetch(
      restoreReq({ vault: "rp-mine", key: "vault-rp-mine/snapshots/2020-01-01T00-00-00-000Z.tar" }, cookie),
      env,
    );
    expect(await unknown.text()).toContain("That restore point wasn&#39;t recognized");
    // My vault, but the key points at THEIR prefix (mirror row exists for them).
    const crossed = await app.fetch(restoreReq({ vault: "rp-mine", key: theirs.key }, cookie), env);
    expect(await crossed.text()).toContain("That restore point wasn&#39;t recognized");
  });

  test("CSRF / same-origin failures re-render with the session-expired error", async () => {
    const { id: userId } = await seedUser("rp-csrf@example.com");
    await env.DB.prepare("UPDATE users SET plan = 'standard' WHERE id = ?").bind(userId).run();
    await seedVault("rp-csrf-v", userId);
    const entry = wireEntry("rp-csrf-v", "2026-07-02T04:00:00.000Z");
    await seedMirrorRow("rp-csrf-v", entry);
    const session = await seedSession(userId);

    const badCsrf = new Request(`${ISSUER}/console/vaults/restore`, {
      method: "POST",
      body: new URLSearchParams({ __csrf: "wrong", vault: "rp-csrf-v", key: entry.key }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: ISSUER,
        cookie: sessionCookie(session),
      },
    });
    expect(await (await app.fetch(badCsrf, env)).text()).toContain("Your session expired");

    const badOrigin = new Request(`${ISSUER}/console/vaults/restore`, {
      method: "POST",
      body: new URLSearchParams({ __csrf: CSRF, vault: "rp-csrf-v", key: entry.key }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://evil.example",
        cookie: sessionCookie(session),
      },
    });
    expect(await (await app.fetch(badOrigin, env)).text()).toContain("Your session expired");
  });

  test("a failed DO restore keeps the target row and reports honestly", async () => {
    const { id: userId } = await seedUser("rp-fail@example.com");
    await env.DB.prepare("UPDATE users SET plan = 'standard' WHERE id = ?").bind(userId).run();
    await seedVault("rp-fail-v", userId);
    const entry = wireEntry("rp-fail-v", "2026-07-02T04:00:00.000Z");
    await seedMirrorRow("rp-fail-v", entry);
    const target = restoredVaultName("rp-fail-v", new Date());
    interceptRestoreFlow(target, { restoreStatus: 500 });

    const res = await quietly(async () =>
      app.fetch(restoreReq({ vault: "rp-fail-v", key: entry.key }, sessionCookie(await seedSession(userId))), env),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Restore didn&#39;t complete");
    // The target row survives — a retry reuses it (documented semantics).
    const row = await env.DB.prepare("SELECT 1 AS one FROM vaults WHERE name = ?").bind(target).first();
    expect(row).not.toBeNull();
  });
});

// --- the staging-only trigger -----------------------------------------------------------

describe("staging snapshot trigger", () => {
  test("POST /__test/snapshot-run answers the sweep summary off-production and 404s ON production", async () => {
    const { id: owner } = await seedUser("trigger-snap@example.com");
    await seedVault("trig-snap-v", owner);
    const manifest = [wireEntry("trig-snap-v", "2026-06-29T04:00:00.000Z", { ranks: ["daily", "weekly"] })];
    interceptSnapshotPost("trig-snap-v", { skipped: false, manifest });

    const req = () => new Request(`${ISSUER}/__test/snapshot-run`, { method: "POST" });
    const staging = await quietly(async () => worker.fetch(req(), env));
    expect(staging.status).toBe(200);
    const summary = (await staging.json()) as { taken: number; failed: number };
    expect(summary.taken).toBe(1);
    expect(summary.failed).toBe(0);
    expect((await mirrorRows()).map((r) => r.key)).toEqual([manifest[0]!.key]);

    const prod = await worker.fetch(req(), { ...env, ENVIRONMENT: "production" });
    expect(prod.status).toBe(404);
  });

  test("?vault=<name> scopes the trigger to that one vault (smoke §17's O(1) restore setup)", async () => {
    const { id: owner } = await seedUser("trigger-scope@example.com");
    await seedVault("trig-scope-a", owner);
    await seedVault("trig-scope-b", owner);
    const manifest = [wireEntry("trig-scope-a", "2026-06-29T04:00:00.000Z")];
    interceptSnapshotPost("trig-scope-a", { skipped: false, manifest });

    const res = await quietly(async () =>
      worker.fetch(new Request(`${ISSUER}/__test/snapshot-run?vault=trig-scope-a`, { method: "POST" }), env),
    );
    expect(res.status).toBe(200);
    const summary = (await res.json()) as { vaults: number; taken: number };
    expect(summary.vaults).toBe(1); // only the scoped vault, not the fleet
    expect(summary.taken).toBe(1);
    // trig-scope-b was never snapshotted — no interceptor + assertNoPendingInterceptors.
    expect((await mirrorRows()).map((r) => r.vault_name)).toEqual(["trig-scope-a"]);
  });
});
