/**
 * GFS snapshot history (Wave 4e) — two layers:
 *
 *  1. The GFS core, pure (snapshots.ts): ISO-week/month keys, rank-at-birth
 *     promotion (first-of-week → weekly, first-of-month → monthly), retention
 *     ("newest N per rank, survive under any rank"), and the take-or-skip
 *     decision — driven by fake-clock simulations across week/month/year
 *     boundaries. This is the heart of the rotation; the sims replay exactly
 *     what the nightly cron does, day by day.
 *
 *  2. The DO endpoint (POST /api/internal/snapshot + GET /api/internal/
 *     snapshots): first-party auth matrix (the plan-cap seam's), tarball +
 *     manifest writes, retention pruning against real R2, the free-tier
 *     skip, cap-gate bypass (a FULL vault still snapshots), and quota
 *     honesty (the r2_bytes meter never moves — snapshots/ is outside the
 *     tenant cap, same posture as exports/).
 */
import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { FIRST_PARTY_CLIENT_ID } from "../src/auth.ts";
import {
  isoWeekKey,
  loadManifest,
  manifestKey,
  monthKey,
  ranksFor,
  retainedKeys,
  snapshotPrefix,
  validateRetention,
  wouldRetain,
  type RetentionPolicy,
  type SnapshotEntry,
} from "../src/snapshots.ts";
import { OP, base, createNote, freshVault, mintToken, op } from "./helpers.ts";

const PAID: RetentionPolicy = { daily: 14, weekly: 8, monthly: 12 };
const FREE: RetentionPolicy = { daily: 0, weekly: 1, monthly: 0 };

// --- the GFS core, pure ------------------------------------------------------

describe("GFS — ISO week / month keys", () => {
  it("computes ISO-8601 weeks across year boundaries (week 1 = first Thursday's week)", () => {
    // 2026-01-01 is a Thursday → week 1 of 2026 runs 2025-12-29 … 2026-01-04.
    expect(isoWeekKey(new Date("2026-01-01T04:00:00Z"))).toBe("2026-W01");
    expect(isoWeekKey(new Date("2025-12-29T04:00:00Z"))).toBe("2026-W01"); // Monday of that week
    expect(isoWeekKey(new Date("2026-01-04T04:00:00Z"))).toBe("2026-W01"); // Sunday of that week
    expect(isoWeekKey(new Date("2026-01-05T04:00:00Z"))).toBe("2026-W02");
    // 2024-12-30 (Mon) already belongs to 2025's week 1.
    expect(isoWeekKey(new Date("2024-12-30T04:00:00Z"))).toBe("2025-W01");
    // 2026 is a 53-week ISO year (starts on a Thursday); the spillover week.
    expect(isoWeekKey(new Date("2026-12-31T04:00:00Z"))).toBe("2026-W53");
    expect(isoWeekKey(new Date("2027-01-01T04:00:00Z"))).toBe("2026-W53");
    expect(isoWeekKey(new Date("2027-01-04T04:00:00Z"))).toBe("2027-W01");
  });

  it("month keys are UTC calendar months", () => {
    expect(monthKey(new Date("2026-07-03T04:00:00Z"))).toBe("2026-07");
    expect(monthKey(new Date("2026-12-31T23:59:59Z"))).toBe("2026-12");
  });
});

/** One fake snapshot entry per instant (pure sims never touch R2). */
function fakeEntry(at: Date, ranks: SnapshotEntry["ranks"]): SnapshotEntry {
  return { key: `vault-sim/snapshots/${at.toISOString()}.tar`, taken_at: at.toISOString(), bytes: 1, notes: 1, ranks };
}

/** Replay the nightly cron over `instants` under `policy` — exactly the DO's
 *  take-or-skip + prune sequence, without R2. */
function simulate(instants: Date[], policy: RetentionPolicy): {
  manifest: SnapshotEntry[];
  taken: number;
  skipped: number;
} {
  let manifest: SnapshotEntry[] = [];
  let taken = 0;
  let skipped = 0;
  for (const at of instants) {
    const ranks = ranksFor(at, manifest);
    if (!wouldRetain(ranks, policy)) {
      skipped++;
      continue;
    }
    manifest.push(fakeEntry(at, ranks));
    const retained = retainedKeys(manifest, policy);
    manifest = manifest.filter((s) => retained.has(s.key));
    taken++;
  }
  return { manifest, taken, skipped };
}

/** N nightly instants at 04:00 UTC starting from `startDay` (YYYY-MM-DD). */
function nightly(startDay: string, days: number): Date[] {
  const start = new Date(`${startDay}T04:00:00.000Z`);
  return Array.from({ length: days }, (_, i) => new Date(start.getTime() + i * 86_400_000));
}

describe("GFS — rank-at-birth promotion", () => {
  it("the very first snapshot carries all three ranks (first of its week AND month)", () => {
    expect(ranksFor(new Date("2026-07-01T04:00:00Z"), [])).toEqual(["daily", "weekly", "monthly"]);
  });

  it("week boundary: Monday's snapshot becomes the week's weekly; month boundary: the 1st's becomes the monthly", () => {
    // Mon Jun 29 2026 → nightly through Wed Jul 8.
    const { manifest } = simulate(nightly("2026-06-29", 10), PAID);
    const ranksByDay = new Map(manifest.map((s) => [s.taken_at.slice(0, 10), s.ranks]));
    expect(ranksByDay.get("2026-06-29")).toEqual(["daily", "weekly", "monthly"]); // first ever
    expect(ranksByDay.get("2026-06-30")).toEqual(["daily"]);
    expect(ranksByDay.get("2026-07-01")).toEqual(["daily", "monthly"]); // new month, mid-week (Wed)
    expect(ranksByDay.get("2026-07-06")).toEqual(["daily", "weekly"]); // next Monday
    expect(ranksByDay.get("2026-07-07")).toEqual(["daily"]);
  });

  it("a missed Monday self-heals: the week's FIRST actual snapshot takes the weekly rank", () => {
    // Week of Mon Jul 6 2026 — the cron missed Mon+Tue; Wednesday runs first.
    const instants = [...nightly("2026-06-29", 7), ...nightly("2026-07-08", 3)]; // gap: Jul 6, Jul 7
    const { manifest } = simulate(instants, PAID);
    const wed = manifest.find((s) => s.taken_at.startsWith("2026-07-08"));
    expect(wed?.ranks).toContain("weekly"); // first snapshot of W28 despite being a Wednesday
  });
});

describe("GFS — retention over long horizons (fake clock)", () => {
  it("paid policy over 400 nightly runs → exactly 14 dailies, the newest 8 weeklies, exactly 12 monthlies", () => {
    const instants = nightly("2026-01-01", 400); // → 2027-02-04
    const { manifest, taken, skipped } = simulate(instants, PAID);
    expect(taken).toBe(400); // paid: every night is retained-as-daily → always taken
    expect(skipped).toBe(0);

    const days = manifest.map((s) => s.taken_at.slice(0, 10));
    // The newest 14 days are all present (the daily window).
    const newest14 = instants.slice(-14).map((d) => d.toISOString().slice(0, 10));
    for (const d of newest14) expect(days).toContain(d);

    // Exactly 12 monthly-ranked survive: 14 first-of-month snapshots were ever
    // taken (2026-01 … 2027-02); the two oldest aged out of the 12-slot rank
    // (and are too old for daily/weekly to save them).
    const monthlies = manifest.filter((s) => s.ranks.includes("monthly"));
    expect(monthlies.map((s) => s.taken_at.slice(0, 7)).sort()).toEqual([
      "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08",
      "2026-09", "2026-10", "2026-11", "2026-12", "2027-01", "2027-02",
    ]);

    // The newest 8 weekly-ranked snapshots ever taken all survive; any OTHER
    // surviving weekly rode the monthly rank (first-of-month ∧ first-of-week).
    const allWeeklies = instants
      .filter((d, i) => {
        const prior = instants.slice(0, i);
        return !prior.some((p) => isoWeekKey(p) === isoWeekKey(d));
      })
      .map((d) => d.toISOString());
    const retainedWeeklies = manifest.filter((s) => s.ranks.includes("weekly"));
    const newest8 = new Set(allWeeklies.slice(-8));
    const newest14Days = new Set(instants.slice(-14).map((d) => d.toISOString()));
    for (const w of allWeeklies.slice(-8)) expect(retainedWeeklies.map((s) => s.taken_at)).toContain(w);
    // …and NO weekly outside the newest 8 survives unless another rank
    // (monthly / the 14-day daily window) carries it.
    for (const s of retainedWeeklies) {
      expect(newest8.has(s.taken_at) || s.ranks.includes("monthly") || newest14Days.has(s.taken_at)).toBe(true);
    }

    // Union bound: ≤ 14+8+12, ≥ max(14, 12) — and the oldest survivor is the
    // ~12-months-back monthly, proving deep history survives the daily churn.
    expect(manifest.length).toBeGreaterThanOrEqual(14);
    expect(manifest.length).toBeLessThanOrEqual(34);
    expect(manifest[0]!.taken_at.slice(0, 10)).toBe("2026-03-01");
  });

  it("free policy (0/1/0) → one export per ISO week, one rolling weekly retained", () => {
    // Wed Jul 1 2026 → 30 nights. ISO weeks touched: W27 (Jul 1), W28 (Jul 6),
    // W29 (Jul 13), W30 (Jul 20), W31 (Jul 27) → 5 taken, 25 skipped.
    const { manifest, taken, skipped } = simulate(nightly("2026-07-01", 30), FREE);
    expect(taken).toBe(5);
    expect(skipped).toBe(25);
    expect(manifest.length).toBe(1); // the rolling weekly
    expect(manifest[0]!.taken_at.slice(0, 10)).toBe("2026-07-27"); // the newest week's first
  });

  it("paid → free downgrade converges to the single rolling weekly at the next week boundary", () => {
    const paidPhase = simulate(nightly("2026-06-01", 30), PAID); // through Jun 30
    let manifest = paidPhase.manifest;
    expect(manifest.length).toBeGreaterThan(14);

    // Free policy from Jul 1. Jul 1 (Wed) ranks daily+monthly → nothing free
    // retains → SKIPPED (paid-era history lingers ≤ one week, documented).
    const jul1 = new Date("2026-07-01T04:00:00.000Z");
    expect(wouldRetain(ranksFor(jul1, manifest), FREE)).toBe(false);

    // Mon Jul 6 = first of W28 → weekly → taken; the prune sweeps everything
    // else out. The rolling weekly stands alone.
    const jul6 = new Date("2026-07-06T04:00:00.000Z");
    const ranks = ranksFor(jul6, manifest);
    expect(ranks).toContain("weekly");
    manifest.push(fakeEntry(jul6, ranks));
    const retained = retainedKeys(manifest, FREE);
    manifest = manifest.filter((s) => retained.has(s.key));
    expect(manifest.length).toBe(1);
    expect(manifest[0]!.taken_at).toBe(jul6.toISOString());
  });
});

describe("GFS — retention policy validation", () => {
  it("accepts well-formed policies and refuses garbage / all-zero / out-of-range", () => {
    expect(validateRetention({ daily: 14, weekly: 8, monthly: 12 })).toEqual({ policy: PAID });
    expect(validateRetention({ daily: 0, weekly: 1, monthly: 0 })).toEqual({ policy: FREE });
    for (const bad of [null, "x", {}, { daily: 1, weekly: 1 }, { daily: -1, weekly: 0, monthly: 0 },
      { daily: 1.5, weekly: 0, monthly: 0 }, { daily: 1001, weekly: 0, monthly: 0 },
      { daily: 0, weekly: 0, monthly: 0 }, { daily: "14", weekly: 8, monthly: 12 }]) {
      expect("error" in validateRetention(bad as never)).toBe(true);
    }
  });
});

// --- the DO endpoint ---------------------------------------------------------

/** First-party admin token — exactly what identity's snapshot sweep mints. */
async function firstPartyToken(vault: string): Promise<string> {
  return mintToken({ vault, scopes: `vault:${vault}:admin`, vaultScope: [vault], clientId: FIRST_PARTY_CLIENT_ID });
}

function snapshotReq(vault: string, token: string, retention: unknown): Promise<Response> {
  return SELF.fetch(`${base(vault)}/api/internal/snapshot`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ retention }),
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function listTarKeys(vault: string): Promise<string[]> {
  const listed = await env.ATTACHMENTS.list({ prefix: snapshotPrefix(vault) });
  return listed.objects.map((o) => o.key).filter((k) => k.endsWith(".tar")).sort();
}

interface SnapshotResponse {
  skipped: boolean;
  reason?: string;
  entry?: SnapshotEntry;
  pruned?: string[];
  manifest: SnapshotEntry[];
}

describe("POST /api/internal/snapshot — authorization matrix (the plan-cap seam's)", () => {
  it("first-party admin + operator bearer are accepted; tenant admin / first-party write / tenant read are refused", async () => {
    const v = freshVault("sn");
    await createNote(v, { content: "snapshot me" });

    const fp = await snapshotReq(v, await firstPartyToken(v), PAID);
    expect(fp.status).toBe(200);

    const opRes = await SELF.fetch(`${base(v)}/api/internal/snapshots`, { headers: { authorization: `Bearer ${OP}` } });
    expect(opRes.status).toBe(200);

    const tenantAdmin = await mintToken({
      vault: v,
      scopes: `vault:${v}:admin`,
      vaultScope: [v],
      clientId: "3f6a2e9b-1111-4222-8333-444455556666", // a DCR-shaped id
    });
    expect((await snapshotReq(v, tenantAdmin, PAID)).status).toBe(403);

    const fpWrite = await mintToken({ vault: v, scopes: `vault:${v}:write`, vaultScope: [v], clientId: FIRST_PARTY_CLIENT_ID });
    expect((await snapshotReq(v, fpWrite, PAID)).status).toBe(403);

    const tenantRead = await mintToken({ vault: v, scopes: `vault:${v}:read`, vaultScope: [v] });
    const listDenied = await SELF.fetch(`${base(v)}/api/internal/snapshots`, {
      headers: { authorization: `Bearer ${tenantRead}` },
    });
    expect(listDenied.status).toBe(403);
  });

  it("bad retention → 400; malformed JSON → 400", async () => {
    const v = freshVault("sn");
    const token = await firstPartyToken(v);
    expect((await snapshotReq(v, token, { daily: 0, weekly: 0, monthly: 0 })).status).toBe(400);
    expect((await snapshotReq(v, token, { daily: -1, weekly: 1, monthly: 0 })).status).toBe(400);
    const raw = await SELF.fetch(`${base(v)}/api/internal/snapshot`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "not json",
    });
    expect(raw.status).toBe(400);
  });
});

describe("POST /api/internal/snapshot — tarball + manifest", () => {
  it("writes the tarball under snapshots/ with a server-derived key + a manifest that round-trips", async () => {
    const v = freshVault("sn");
    await createNote(v, { content: "the snapshot content", path: "notes/snap" });

    const res = await snapshotReq(v, OP, PAID);
    expect(res.status).toBe(200);
    const body = (await res.json()) as SnapshotResponse;
    expect(body.skipped).toBe(false);
    expect(body.entry!.key).toMatch(/^vault-.*\/snapshots\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.tar$/);
    expect(body.entry!.ranks).toEqual(["daily", "weekly", "monthly"]); // first ever
    expect(body.entry!.bytes).toBeGreaterThan(0);
    expect(body.entry!.notes).toBeGreaterThan(0);
    expect(body.manifest).toEqual([body.entry]);

    // The tarball + manifest actually exist in R2, and the manifest matches.
    expect(await listTarKeys(v)).toEqual([body.entry!.key]);
    const stored = await loadManifest(env.ATTACHMENTS, v);
    expect(stored.snapshots).toEqual([body.entry]);

    // GET /api/internal/snapshots reads the same manifest.
    const list = await SELF.fetch(`${base(v)}/api/internal/snapshots`, {
      headers: { authorization: `Bearer ${await firstPartyToken(v)}` },
    });
    expect(((await list.json()) as { snapshots: SnapshotEntry[] }).snapshots).toEqual([body.entry]);
  });

  it("free policy: the first snapshot of the week is taken; a same-week re-run is SKIPPED (no export work)", async () => {
    const v = freshVault("sn");
    await createNote(v, { content: "weekly only" });

    const first = (await (await snapshotReq(v, OP, FREE)).json()) as SnapshotResponse;
    expect(first.skipped).toBe(false);
    const keysAfterFirst = await listTarKeys(v);
    expect(keysAfterFirst.length).toBe(1);

    await sleep(3);
    const second = (await (await snapshotReq(v, OP, FREE)).json()) as SnapshotResponse;
    expect(second.skipped).toBe(true);
    expect(second.reason).toBe("no_retained_rank");
    expect(await listTarKeys(v)).toEqual(keysAfterFirst); // nothing written
    expect(second.manifest).toEqual(first.manifest); // manifest untouched
  });

  it("retention prunes R2 + manifest to the policy (keep newest 1 daily)", async () => {
    const v = freshVault("sn");
    await createNote(v, { content: "churn" });
    const policy = { daily: 1, weekly: 0, monthly: 0 };

    const r1 = (await (await snapshotReq(v, OP, policy)).json()) as SnapshotResponse;
    await sleep(3);
    const r2 = (await (await snapshotReq(v, OP, policy)).json()) as SnapshotResponse;
    await sleep(3);
    const r3 = (await (await snapshotReq(v, OP, policy)).json()) as SnapshotResponse;

    // Each run retains only the newest daily; the prior tarball dies with it.
    expect(r2.pruned).toEqual([r1.entry!.key]);
    expect(r3.pruned).toEqual([r2.entry!.key]);
    expect(r3.manifest).toEqual([r3.entry]);
    expect(await listTarKeys(v)).toEqual([r3.entry!.key]);
    // manifest.json survives the prune (non-.tar keys are never deleted).
    expect(await env.ATTACHMENTS.get(manifestKey(v))).not.toBeNull();
  });

  it("snapshots are EXCLUDED from the r2_bytes cap meter (write + prune leave it unchanged)", async () => {
    const v = freshVault("sn");
    await createNote(v, { content: "metered vault" });
    const form = new FormData();
    form.set("file", new File([new Uint8Array(64)], "m.png", { type: "image/png" }));
    expect((await op(v, "/api/storage/upload", { method: "POST", body: form })).status).toBe(201);

    const stub = env.VAULT.get(env.VAULT.idFromName(v));
    expect(await stub.debugR2MeterBytes(v)).toBe(64);

    const policy = { daily: 1, weekly: 0, monthly: 0 };
    for (let i = 0; i < 3; i++) {
      expect((await snapshotReq(v, OP, policy)).status).toBe(200);
      await sleep(3);
    }
    expect(await stub.debugR2MeterBytes(v)).toBe(64); // untouched either direction
  });

  it("a FULL (over-cap) vault still snapshots — internal dispatch precedes the cap gate", async () => {
    const v = freshVault("sn");
    await createNote(v, { content: "content before the cap lands" });
    // Push a cap below the current DB size: instantly over cap.
    const capRes = await SELF.fetch(`${base(v)}/api/internal/config`, {
      method: "PUT",
      headers: { authorization: `Bearer ${OP}`, "content-type": "application/json" },
      body: JSON.stringify({ cap_bytes: 1024 }),
    });
    expect(capRes.status).toBe(200);
    // Growth writes 413 …
    const blocked = await op(v, "/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "no room" }),
    });
    expect(blocked.status).toBe(413);
    // … but the nightly snapshot must land anyway (backup of a full vault).
    const snap = await snapshotReq(v, OP, PAID);
    expect(snap.status).toBe(200);
    expect(((await snap.json()) as SnapshotResponse).skipped).toBe(false);
  });

  it("snapshot prune never touches exports/ or attachments/ prefixes", async () => {
    const v = freshVault("sn");
    await createNote(v, { content: "prefix isolation" });
    // An export tarball + an attachment.
    expect((await op(v, "/api/export")).status).toBe(200);
    const form = new FormData();
    form.set("file", new File([new Uint8Array([1, 2, 3])], "keep.png", { type: "image/png" }));
    const up = await op(v, "/api/storage/upload", { method: "POST", body: form });
    const meta = (await up.json()) as { path: string };

    const policy = { daily: 1, weekly: 0, monthly: 0 };
    for (let i = 0; i < 3; i++) {
      expect((await snapshotReq(v, OP, policy)).status).toBe(200);
      await sleep(3);
    }
    // The export tarball + the attachment both survive the snapshot prunes.
    const exports = await env.ATTACHMENTS.list({ prefix: `vault-${v}/exports/` });
    expect(exports.objects.length).toBe(1);
    expect((await op(v, `/api/storage/${meta.path}`)).status).toBe(200);
  });
});
