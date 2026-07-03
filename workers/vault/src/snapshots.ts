/**
 * GFS snapshot history — the vault-side machinery (Wave 4e).
 *
 * Nightly (SNAPSHOT_CRON on the identity worker, 04:00 UTC), each vault DO is
 * asked to snapshot itself through `POST /api/internal/snapshot` (first-party
 * gated, exactly like the plan-cap seam). The DO runs the SAME core export
 * engine the on-demand export uses (export.ts — the byte-identity guarantee
 * chains through here too), tars it, and writes to
 * `vault-<name>/snapshots/<server-ts>.tar` — a prefix the export prune never
 * touches (the seam reserved in #39).
 *
 * ## The GFS promotion algorithm (grandfather–father–son), exactly
 *
 * Ranks are assigned AT CREATION against the manifest, and are immutable:
 *
 *   - every snapshot carries rank `daily` (the son);
 *   - a snapshot ADDITIONALLY carries rank `weekly` (the father) when the
 *     manifest holds no other snapshot in the same ISO-8601 week — i.e. the
 *     first snapshot taken in a new week IS that week's weekly. This is the
 *     classic "a daily becomes the week's weekly on the week boundary",
 *     implemented as rank-at-birth rather than a later re-tag: retention is
 *     rank-driven, so when the pure dailies of that week age out, the
 *     weekly-ranked one survives — the promotion is the survival;
 *   - a snapshot additionally carries rank `monthly` (the grandfather) when
 *     the manifest holds no other snapshot in the same UTC calendar month.
 *
 *   The checks are calendar-based, not weekday-based: if the cron misses
 *   Monday, Tuesday's snapshot is the week's first and gets the weekly rank —
 *   the rotation self-heals across missed runs. The very first snapshot of a
 *   vault carries all three ranks (it's first in its week AND month).
 *
 * ## Retention
 *
 *   Per rank, keep the newest `policy[rank]` snapshots carrying that rank; a
 *   snapshot survives if ANY rank retains it. Paid: 14 daily / 8 weekly / 12
 *   monthly (≈ two weeks of days + two months of weeks + a year of months).
 *   Free: 0 / 1 / 0 — one rolling weekly, kept for OUR disaster recovery
 *   (never user-facing; the policy is decided caller-side from the plan).
 *
 *   A snapshot whose ranks retain nothing under the caller's policy is not
 *   taken at all (`wouldRetain` → the run reports `skipped`): a free vault
 *   only exports once per ISO week instead of doing nightly work that the
 *   prune would immediately discard.
 *
 * ## The manifest (R2, `vault-<name>/snapshots/manifest.json`) — why R2
 *
 *   The manifest lives NEXT TO the tarballs in R2, not in DO storage, for two
 *   load-bearing reasons: (1) restore runs in a DIFFERENT DO (the new target
 *   vault) which can read the source's manifest/tarball from the shared
 *   bucket but could never reach the source DO's private storage; (2) the
 *   manifest must survive the exact disaster snapshots guard against — losing
 *   the DO. Single-writer stays intact: only the vault's OWN DO ever writes
 *   its manifest (the snapshot verb), so there is no cross-writer race.
 *
 *   Write order per run: tarball → prune (list-based: any `.tar` under the
 *   prefix not in the retained set dies — this self-heals tarballs orphaned
 *   by a crash between tarball-write and manifest-write) → manifest. A
 *   corrupt (unparseable) manifest FAILS the run rather than being treated as
 *   empty — an empty read would mass-prune every existing tarball.
 *
 * ## Quota honesty
 *
 *   Snapshots are operational backup artifacts, not user content: the write
 *   path never calls `meterAdd` and the prune never calls `meterSub` — the
 *   same posture as `exports/` (export.ts), pinned by the conformance suite.
 */

export type SnapshotRank = "daily" | "weekly" | "monthly";

export const SNAPSHOT_RANKS: readonly SnapshotRank[] = ["daily", "weekly", "monthly"];

/** How many snapshots each rank retains (0 = the rank retains nothing). */
export interface RetentionPolicy {
  daily: number;
  weekly: number;
  monthly: number;
}

/** One snapshot in the manifest. Ranks are assigned at creation, immutable. */
export interface SnapshotEntry {
  /** Full R2 key (`vault-<name>/snapshots/<server-ts>.tar`). */
  key: string;
  /** ISO-8601 server time the snapshot was taken. */
  taken_at: string;
  /** Tarball size in bytes (the console's "size" column). */
  bytes: number;
  /** Notes in the vault at snapshot time (human context in the console). */
  notes: number;
  /** GFS ranks (see the module note). Always includes "daily". */
  ranks: SnapshotRank[];
}

export interface SnapshotManifest {
  version: 1;
  vault: string;
  /** Ascending by taken_at (keys embed server time, so key order matches). */
  snapshots: SnapshotEntry[];
}

/** The R2 key prefix snapshots live under — one place, like exportPrefix. */
export function snapshotPrefix(vaultName: string): string {
  return `vault-${vaultName}/snapshots/`;
}

/** The manifest's R2 key (inside the prefix; the prune skips non-`.tar` keys). */
export function manifestKey(vaultName: string): string {
  return `${snapshotPrefix(vaultName)}manifest.json`;
}

// ---------------------------------------------------------------------------
// Calendar keys (pure, UTC)
// ---------------------------------------------------------------------------

/**
 * ISO-8601 week key ("2026-W27") for a UTC instant. Weeks start Monday; week 1
 * is the week containing the year's first Thursday — so the ISO year at the
 * boundary can differ from the calendar year (2027-01-01 → "2026-W53").
 */
export function isoWeekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayFromMonday = (t.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  t.setUTCDate(t.getUTCDate() - dayFromMonday + 3); // this week's Thursday
  const isoYear = t.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4)); // Jan 4 is always in week 1
  const week = 1 + Math.round(((t.getTime() - jan4.getTime()) / 86_400_000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

/** UTC calendar-month key ("2026-07"). */
export function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// GFS core (pure — the retention/rotation tests drive these directly)
// ---------------------------------------------------------------------------

/**
 * Ranks for a snapshot taken at `takenAt`, given the manifest's existing
 * entries: always `daily`; plus `weekly`/`monthly` when no existing entry
 * shares its ISO week / UTC month (the promotion rule, module note).
 */
export function ranksFor(takenAt: Date, existing: readonly SnapshotEntry[]): SnapshotRank[] {
  const ranks: SnapshotRank[] = ["daily"];
  const week = isoWeekKey(takenAt);
  const month = monthKey(takenAt);
  if (!existing.some((e) => isoWeekKey(new Date(e.taken_at)) === week)) ranks.push("weekly");
  if (!existing.some((e) => monthKey(new Date(e.taken_at)) === month)) ranks.push("monthly");
  return ranks;
}

/** Would a snapshot with `ranks` survive `policy` at all? (false → don't take it.) */
export function wouldRetain(ranks: readonly SnapshotRank[], policy: RetentionPolicy): boolean {
  return ranks.some((r) => policy[r] > 0);
}

/**
 * The retained key set: per rank, the newest `policy[rank]` entries carrying
 * that rank; union across ranks (survive-under-any-rank).
 */
export function retainedKeys(snapshots: readonly SnapshotEntry[], policy: RetentionPolicy): Set<string> {
  const keep = new Set<string>();
  for (const rank of SNAPSHOT_RANKS) {
    const n = policy[rank];
    if (n <= 0) continue;
    const ranked = snapshots
      .filter((s) => s.ranks.includes(rank))
      .sort((a, b) => (a.taken_at < b.taken_at ? 1 : a.taken_at > b.taken_at ? -1 : 0)); // newest first
    for (const s of ranked.slice(0, n)) keep.add(s.key);
  }
  return keep;
}

/** Validate a caller-supplied retention policy. Returns an error string or null. */
export function validateRetention(raw: unknown): { policy: RetentionPolicy } | { error: string } {
  if (typeof raw !== "object" || raw === null) return { error: "retention must be an object" };
  const r = raw as Record<string, unknown>;
  const out: Partial<RetentionPolicy> = {};
  for (const rank of SNAPSHOT_RANKS) {
    const v = r[rank];
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0 || v > 1000) {
      return { error: `retention.${rank} must be an integer 0–1000` };
    }
    out[rank] = v;
  }
  const policy = out as RetentionPolicy;
  if (policy.daily === 0 && policy.weekly === 0 && policy.monthly === 0) {
    return { error: "retention must keep at least one snapshot (all ranks are 0)" };
  }
  return { policy };
}

// ---------------------------------------------------------------------------
// Manifest I/O (R2)
// ---------------------------------------------------------------------------

/**
 * Load a vault's manifest. Missing → an empty manifest (first snapshot ever).
 * CORRUPT (unparseable / wrong shape) → throws — the caller must fail the run:
 * treating corruption as empty would make the next prune (retained = the new
 * snapshot only) delete every existing tarball.
 */
export async function loadManifest(bucket: R2Bucket, vaultName: string): Promise<SnapshotManifest> {
  const obj = await bucket.get(manifestKey(vaultName));
  if (!obj) return { version: 1, vault: vaultName, snapshots: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(await obj.text());
  } catch (e) {
    throw new Error(`snapshot manifest for "${vaultName}" is not valid JSON: ${e instanceof Error ? e.message : e}`);
  }
  const m = parsed as SnapshotManifest;
  if (m?.version !== 1 || !Array.isArray(m.snapshots)) {
    throw new Error(`snapshot manifest for "${vaultName}" has an unexpected shape (version=${(m as { version?: unknown })?.version})`);
  }
  return m;
}

export async function saveManifest(bucket: R2Bucket, manifest: SnapshotManifest): Promise<void> {
  await bucket.put(manifestKey(manifest.vault), JSON.stringify(manifest));
}

/**
 * List-based prune: delete every `.tar` under the snapshot prefix that isn't
 * in `retained`. List-based (not manifest-based) so tarballs orphaned by a
 * crash between tarball-write and manifest-write are reaped on the next run.
 * Never touches `manifest.json` (non-`.tar`) and never calls `meterSub`
 * (snapshots are outside the tenant cap meter — module note).
 */
export async function pruneSnapshotTarballs(
  bucket: R2Bucket,
  vaultName: string,
  retained: ReadonlySet<string>,
): Promise<string[]> {
  const prefix = snapshotPrefix(vaultName);
  const stale: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) });
    for (const obj of page.objects) {
      if (obj.key.endsWith(".tar") && !retained.has(obj.key)) stale.push(obj.key);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  for (let i = 0; i < stale.length; i += 1000) {
    await bucket.delete(stale.slice(i, i + 1000));
  }
  return stale;
}
