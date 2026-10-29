/**
 * The nightly GFS snapshot sweep + the console's restore-point plumbing
 * (Wave 4e). Identity-side responsibilities only:
 *
 *   - SNAPSHOT_CRON (ops.ts, 04:00 UTC — after the 03:30 usage rollup):
 *     enumerate `vaults` JOIN `users`, and ask each vault DO to snapshot
 *     itself (`POST /api/internal/snapshot`) through the vault-call.ts mint
 *     seam (first-party admin, aud-pinned, 60s — the #51/#57 contract),
 *     passing the OWNER'S PLAN retention policy (plans.ts): paid 14/8/12,
 *     free 0/1/0 (the internal rolling weekly — the vault worker skips
 *     nights nothing would retain, so free vaults export weekly, not
 *     nightly). The ROTATION algorithm itself lives vault-side
 *     (workers/vault/src/snapshots.ts) next to the tarballs it governs;
 *     this side only knows WHO gets WHAT policy.
 *
 *   - D1 mirror (`vault_snapshots`, migration 0013): the snapshot verb
 *     returns the post-run manifest, and the sweep replaces the vault's rows
 *     with it — so the console's History section renders from a cheap D1
 *     read instead of waking every DO per page view (the vault_usage
 *     precedent). The R2 manifest stays the source of truth: restore-time
 *     validation happens in the target DO against R2, and a stale mirror row
 *     at worst 404s into a friendly error.
 *
 *   - Orphan prune (cloud#227): a fleet-wide sweep ends by dropping
 *     `vault_snapshots` rows whose vault is gone from `vaults` — the BACKSTOP
 *     behind the delete path's synchronous prune (vaults.ts
 *     `deleteVaultD1Rows`). Without it the mirror grew without bound, because
 *     the sweep only ever revisits vaults that still exist. See
 *     {@link pruneOrphanSnapshotRows}.
 *
 *   - Failure posture mirrors the usage rollup: one vault's failed snapshot
 *     logs `event=snapshot_failed` (vault name only, PII-free) and the run
 *     CONTINUES — the GFS ranks are calendar-based so a missed night never
 *     corrupts the rotation. Bounded by {@link SNAPSHOT_RUN_CAP}; injectable
 *     clock via deps.
 *
 *   - A failure is NOT assumed to self-heal (T-318: one vault failed every
 *     night for two months and only the log knew). Any failed vault raises
 *     one operator alert per run (ops-alerts.ts, counts only), and the daily
 *     ops line counts vaults whose newest snapshot is overdue
 *     ({@link countStaleSnapshots}), so a failure that repeats stays visible.
 *
 *   - Restore orchestration helpers for the console (console.ts
 *     handleRestorePost): target-name derivation + the internal restore
 *     call. Restore NEVER touches the source vault — it creates (or, for a
 *     same-day retry, reuses) `<vault>-restored-<date>` and replays the
 *     tarball into THAT.
 */
import type { BillingMode } from "./billing-config.ts";
import type { EmailSender } from "./email.ts";
import type { Env } from "./env.ts";
import { type OAuthDeps, billingModeOf } from "./oauth-shared.ts";
import { raiseOpsAlert } from "./ops-alerts.ts";
import { PLAN_SPECS, coercePlanId, livePlan, type SnapshotRetention } from "./plans.ts";
import { callVaultApi } from "./vault-call.ts";

/**
 * Per-run bound on vault snapshots — same rationale + growth note as
 * USAGE_RUN_CAP (usage.ts): current fleets are tiny; paginate by name cursor
 * (or fan out via a queue) before raising this.
 */
export const SNAPSHOT_RUN_CAP = 500;

/** Most vaults one `onlyVaults` run takes — D1's bound-parameter limit per statement. */
export const ONLY_VAULTS_MAX = 100;

/** GFS ranks, mirrored from workers/vault/src/snapshots.ts (wire shape). */
export type SnapshotRank = "daily" | "weekly" | "monthly";

/** One manifest entry as the vault worker reports it (wire shape). */
export interface SnapshotEntryWire {
  key: string;
  taken_at: string;
  bytes: number;
  notes: number;
  ranks: SnapshotRank[];
}

export interface SnapshotSweepSummary {
  /** UTC day of the run ("YYYY-MM-DD"). */
  day: string;
  /** Vaults enumerated this run (≤ cap). */
  vaults: number;
  /** Snapshots actually taken. */
  taken: number;
  /** Vaults where the DO skipped (nothing the policy would retain — free-tier mid-week). */
  skipped: number;
  /** Vaults whose snapshot call failed (logged; self-heal next night). */
  failed: number;
  /** True when enumeration stopped at the cap with vaults still unswept. */
  capped: boolean;
  /**
   * Entries across this run's snapshots whose path needed a PAX record (a note
   * title over 100 bytes — the T-318 failure). Count only; 0 from an older
   * vault worker that doesn't report it.
   */
  longPaths: number;
  /**
   * Orphan `vault_snapshots` rows deleted this run (mirror rows whose vault no
   * longer exists). Always 0 on an `onlyVault` run and on a prune that itself
   * failed — see {@link pruneOrphanSnapshotRows}.
   */
  orphansPruned: number;
}

/**
 * One nightly tick: snapshot every vault under its owner's plan policy and
 * mirror each returned manifest into D1. `opts.runCap` exists only for tests.
 *
 * `opts.onlyVault` scopes the run to a SINGLE vault instead of the whole fleet.
 * The nightly cron never sets it; the staging-only /__test/snapshot-run trigger
 * passes it so the live smoke's restore round-trip (smoke-staging.ts §17) stays
 * O(1) rather than O(fleet) — a fleet-wide sweep outgrew the smoke's client
 * timeout as staging debris accumulated (cloud#166).
 *
 * `opts.onlyVaults` scopes it to a named SET (at most 100 — one D1 statement's
 * bind limit — and the run cap): POST /ops/snapshot-run re-runs the vaults
 * whose backups are stale (ops-daily.ts).
 */
export async function runSnapshotSweep(
  env: Env,
  deps: OAuthDeps,
  opts: { runCap?: number; onlyVault?: string; onlyVaults?: string[]; sender?: EmailSender; fetchFn?: typeof fetch } = {},
): Promise<SnapshotSweepSummary> {
  const runCap = Math.min(opts.runCap ?? SNAPSHOT_RUN_CAP, opts.onlyVaults ? ONLY_VAULTS_MAX : Infinity);
  const scoped = opts.onlyVault !== undefined || opts.onlyVaults !== undefined;
  const set = opts.onlyVaults ? [...new Set(opts.onlyVaults)] : [];
  const now = deps.now?.() ?? new Date();
  const day = now.toISOString().slice(0, 10);

  // Excludes a tombstoned owner (`deleted_at`, migration 0023) — otherwise a
  // deleted account's vault still gets snapshotted nightly.
  const res = opts.onlyVault
    ? await env.DB.prepare(
        `SELECT v.name, v.owner_user_id, u.plan FROM vaults v JOIN users u ON u.id = v.owner_user_id WHERE v.name = ? AND u.deleted_at IS NULL LIMIT 1`,
      )
        .bind(opts.onlyVault)
        .all<{ name: string; owner_user_id: string; plan: string }>()
    : opts.onlyVaults
      ? set.length === 0
        ? { results: [] }
        : await env.DB.prepare(
            `SELECT v.name, v.owner_user_id, u.plan FROM vaults v JOIN users u ON u.id = v.owner_user_id WHERE v.name IN (${set
              .slice(0, runCap + 1)
              .map(() => "?")
              .join(", ")}) AND u.deleted_at IS NULL ORDER BY v.name`,
          )
            .bind(...set.slice(0, runCap + 1))
            .all<{ name: string; owner_user_id: string; plan: string }>()
      : await env.DB.prepare(
        `SELECT v.name, v.owner_user_id, u.plan FROM vaults v JOIN users u ON u.id = v.owner_user_id WHERE u.deleted_at IS NULL ORDER BY v.name LIMIT ?`,
      )
        .bind(runCap + 1)
        .all<{ name: string; owner_user_id: string; plan: string }>();
  const rows = res.results ?? [];
  const capped = rows.length > runCap || set.length > runCap + 1;
  const vaults = capped ? rows.slice(0, runCap) : rows;
  if (capped) console.error(`event=snapshot_sweep_capped cap=${runCap} — paginate before raising (see SNAPSHOT_RUN_CAP note)`);

  let taken = 0;
  let skipped = 0;
  let failed = 0;
  let longPaths = 0;
  for (const v of vaults) {
    try {
      const retention: SnapshotRetention = PLAN_SPECS[livePlan(coercePlanId(v.plan), billingModeOf(deps))].snapshot_retention;
      const resp = await callVaultApi(env.DB, deps, {
        userId: v.owner_user_id,
        vaultName: v.name,
        method: "POST",
        apiPath: "/api/internal/snapshot",
        verb: "admin",
        jsonBody: { retention },
      });
      if (!resp.ok) throw new Error(`internal snapshot POST → HTTP ${resp.status}`);
      const body = (await resp.json()) as { skipped?: unknown; manifest?: unknown; long_paths?: unknown };
      if (typeof body.skipped !== "boolean" || !Array.isArray(body.manifest)) {
        throw new Error("internal snapshot POST carried no run shape (skipped/manifest)");
      }
      body.skipped ? skipped++ : taken++;
      if (typeof body.long_paths === "number" && Number.isSafeInteger(body.long_paths)) longPaths += body.long_paths;
      // The D1 mirror is a render cache — a mirror-only failure is NOT a
      // snapshot failure (the tarball + R2 manifest landed; the console shows
      // last night's rows until tomorrow's sweep refreshes them). Logged under
      // its own event so the sweep summary stays honest about what failed.
      try {
        await mirrorManifest(env.DB, v.name, body.manifest as SnapshotEntryWire[]);
      } catch (err) {
        console.error(
          `event=snapshot_mirror_failed vault=${v.name} error=${JSON.stringify(err instanceof Error ? err.message : String(err))}`,
        );
      }
    } catch (err) {
      // Skip + log + continue — one vault's bad night never starves the rest.
      failed++;
      console.error(
        `event=snapshot_failed vault=${v.name} error=${JSON.stringify(err instanceof Error ? err.message : String(err))}`,
      );
    }
  }

  // The orphan backstop (cloud#227) — fleet-wide runs only.
  const orphansPruned = scoped ? 0 : await pruneOrphanSnapshotRows(env.DB);

  const summary: SnapshotSweepSummary = { day, vaults: vaults.length, taken, skipped, failed, capped, longPaths, orphansPruned };
  console.log(
    `event=snapshot_sweep day=${day} vaults=${summary.vaults} taken=${taken} skipped=${skipped} failed=${failed} capped=${capped} long_paths=${longPaths} orphans_pruned=${orphansPruned}`,
  );
  if (failed > 0) {
    // Counts only: vault names stay in Workers Logs. raiseOpsAlert never throws.
    await raiseOpsAlert(env, opts.sender, {
      key: "snapshot:failed",
      subject: `${failed} of ${vaults.length} vault backups failed (${day})`,
      text: [
        `The nightly snapshot sweep on ${day} could not back up ${failed} of ${vaults.length} vaults.`,
        "Those vaults have no new restore point until the cause is fixed; nothing retries before tomorrow's run.",
        "",
        "Workers Logs (parachute-identity): event=snapshot_failed names each vault and the error;",
        "the vault worker (parachute-vault-do) logs the matching 500 for POST /api/internal/snapshot.",
        "The daily ops line counts vaults whose backups are overdue (stale backups).",
      ].join("\n"),
      now,
      severity: "warning",
      fetchFn: opts.fetchFn,
    });
  }
  return summary;
}

/**
 * Drop `vault_snapshots` rows whose vault is gone (cloud#227).
 *
 * WHY THIS EXISTS. The sweep only ever enumerates rows in `vaults`, so a
 * deleted vault is never visited again and its mirror rows are never revisited
 * or removed — they just accumulate. At the 2026-07-26 staging reclamation
 * there were 1,524 orphan `vault_snapshots` rows (and 1,008 in `vault_usage`)
 * for vaults that no longer existed. The delete path already prunes
 * synchronously (`deleteVaultD1Rows` in vaults.ts, cloud#226/#241); this is the
 * BACKSTOP for whatever that path never reached — a crash between the DO
 * destroy and the D1 batch, a hand-deleted row, or pre-fix debris.
 *
 * SAFE BY CONSTRUCTION. A `vault_name` absent from `vaults` cannot belong to a
 * live vault. Note what this deliberately does NOT catch: a TOMBSTONED owner's
 * vault (migration 0023) is skipped by enumeration but still HOLDS its `vaults`
 * row until its storage is actually destroyed, so it is not an orphan and its
 * mirror survives. Dropping it here would hide still-billed storage — the same
 * hazard purgeAccountRows (account-delete.ts) documents.
 *
 * BOUNDED. One statement, whatever the row count: a single DELETE with a
 * correlated-free subquery, not a per-row loop, so it cannot approach the
 * subrequest or statement budget however much debris has piled up.
 *
 * BEST-EFFORT. The prune is bookkeeping, not the sweep's job — a failure here
 * must not turn a night of good snapshots into a failed run, so it logs under
 * its own event and reports 0. It retries every night by construction.
 */
async function pruneOrphanSnapshotRows(db: D1Database): Promise<number> {
  try {
    const res = await db.prepare("DELETE FROM vault_snapshots WHERE vault_name NOT IN (SELECT name FROM vaults)").run();
    return res.meta.changes ?? 0;
  } catch (err) {
    console.error(
      `event=snapshot_orphan_prune_failed error=${JSON.stringify(err instanceof Error ? err.message : String(err))}`,
    );
    return 0;
  }
}

/** How long a vault's newest snapshot may age before it counts as stale: a
 *  nightly policy (daily > 0) is checked at 03:30, 23.5 h after the last 04:00
 *  run, so 30 h flags the first missed night; a weekly-only policy (the
 *  expired floor) takes one snapshot per ISO week, so 7 days + the same 30 h. */
export const STALE_DAILY_MS = 30 * 3_600_000;
export const STALE_WEEKLY_MS = 7 * 86_400_000 + STALE_DAILY_MS;

/**
 * Vaults the nightly sweep should have backed up but whose newest mirrored
 * snapshot (or, with none at all, the vault's creation) is older than its
 * plan's cadence allows — the stale-backup count on the daily ops line. Same
 * enumeration as the sweep (live owners only), same plan → policy mapping.
 * Counts only.
 */
export async function countStaleSnapshots(
  db: D1Database,
  now: Date,
  mode: BillingMode,
): Promise<{ stale: number; vaults: number }> {
  const { names, vaults } = await staleSnapshotVaults(db, now, mode);
  return { stale: names.length, vaults };
}

/** The stale vaults themselves (names, sorted) — for the re-run endpoint; the
 *  daily line only ever sees the count. */
export async function staleSnapshotVaults(
  db: D1Database,
  now: Date,
  mode: BillingMode,
): Promise<{ names: string[]; vaults: number }> {
  const res = await db
    .prepare(
      `SELECT v.name, v.created_at, u.plan, MAX(s.taken_at) AS newest
       FROM vaults v JOIN users u ON u.id = v.owner_user_id
       LEFT JOIN vault_snapshots s ON s.vault_name = v.name
       WHERE u.deleted_at IS NULL GROUP BY v.name ORDER BY v.name`,
    )
    .all<{ name: string; created_at: string; plan: string; newest: string | null }>();
  const rows = res.results ?? [];
  const names: string[] = [];
  for (const r of rows) {
    const policy = PLAN_SPECS[livePlan(coercePlanId(r.plan), mode)].snapshot_retention;
    const maxAge = policy.daily > 0 ? STALE_DAILY_MS : STALE_WEEKLY_MS;
    const since = Date.parse(r.newest ?? r.created_at);
    if (!Number.isFinite(since) || now.getTime() - since > maxAge) names.push(r.name);
  }
  return { names, vaults: rows.length };
}

/** Replace a vault's D1 mirror rows with the post-run manifest (one batch —
 *  the mirror is never half-old/half-new). */
async function mirrorManifest(db: D1Database, vaultName: string, manifest: SnapshotEntryWire[]): Promise<void> {
  const stmts = [db.prepare("DELETE FROM vault_snapshots WHERE vault_name = ?").bind(vaultName)];
  for (const e of manifest) {
    stmts.push(
      db
        .prepare("INSERT INTO vault_snapshots (vault_name, key, taken_at, bytes, ranks) VALUES (?, ?, ?, ?, ?)")
        .bind(vaultName, e.key, e.taken_at, e.bytes, JSON.stringify(e.ranks)),
    );
  }
  await db.batch(stmts);
}

// --- console reads -------------------------------------------------------------

/** One restore point for the console (a `vault_snapshots` mirror row). */
export interface VaultSnapshotRow {
  vaultName: string;
  key: string;
  takenAt: string;
  bytes: number;
  ranks: SnapshotRank[];
}

/**
 * Restore points per vault for the console render, NEWEST FIRST. Vaults with
 * no rows (fresh, or the nightly sweep hasn't reached them) are absent — the
 * History section renders its "snapshots begin within a day" line instead.
 */
export async function listSnapshotsForVaults(db: D1Database, names: string[]): Promise<Map<string, VaultSnapshotRow[]>> {
  const out = new Map<string, VaultSnapshotRow[]>();
  if (names.length === 0) return out;
  const placeholders = names.map(() => "?").join(", ");
  const res = await db
    .prepare(
      `SELECT vault_name, key, taken_at, bytes, ranks FROM vault_snapshots
       WHERE vault_name IN (${placeholders}) ORDER BY vault_name, taken_at DESC`,
    )
    .bind(...names)
    .all<{ vault_name: string; key: string; taken_at: string; bytes: number; ranks: string }>();
  for (const r of res.results ?? []) {
    const list = out.get(r.vault_name) ?? [];
    list.push({
      vaultName: r.vault_name,
      key: r.key,
      takenAt: r.taken_at,
      bytes: r.bytes,
      ranks: parseRanks(r.ranks),
    });
    out.set(r.vault_name, list);
  }
  return out;
}

function parseRanks(raw: string): SnapshotRank[] {
  try {
    const arr = JSON.parse(raw) as unknown;
    if (Array.isArray(arr)) return arr.filter((r): r is SnapshotRank => r === "daily" || r === "weekly" || r === "monthly");
  } catch {
    // fall through — a corrupt mirror row degrades to no rank chip, never a crash.
  }
  return [];
}

/** Is `key` a mirrored restore point of `vaultName`? (Form-input validation —
 *  the target DO re-validates against R2, the source of truth.) */
export async function isKnownSnapshot(db: D1Database, vaultName: string, key: string): Promise<boolean> {
  if (!key.startsWith(`vault-${vaultName}/snapshots/`) || !key.endsWith(".tar")) return false;
  const row = await db
    .prepare("SELECT 1 AS one FROM vault_snapshots WHERE vault_name = ? AND key = ?")
    .bind(vaultName, key)
    .first<{ one: number }>();
  return row !== null;
}

// --- restore orchestration -------------------------------------------------------

/**
 * The restore target's name: `<source>-restored-<YYYY-MM-DD>`, truncating the
 * source part so the whole name fits the 63-char vault slug. Same-day
 * restores of the same source REUSE this name (console.ts treats an
 * already-owned target as "restore into it again" — blow-away import
 * converges, and a slot is never burned on a retry).
 */
export function restoredVaultName(source: string, now: Date): string {
  const suffix = `-restored-${now.toISOString().slice(0, 10)}`;
  const maxBase = 63 - suffix.length;
  const base = source.length > maxBase ? source.slice(0, maxBase).replace(/-+$/, "") : source;
  return `${base}${suffix}`;
}

/**
 * Ask the TARGET vault's DO to replay the source snapshot into itself
 * (`POST /api/internal/restore` through the mint seam). NOT best-effort:
 * failures throw to the caller — the console reports them honestly (the
 * target vault row is kept: partial content is the owner's own snapshot
 * data, and a same-day retry reuses + re-wipes the target).
 */
export async function callVaultRestore(
  db: D1Database,
  deps: OAuthDeps,
  ownerUserId: string,
  targetVault: string,
  sourceVault: string,
  snapshotKey: string,
): Promise<void> {
  const res = await callVaultApi(db, deps, {
    userId: ownerUserId,
    vaultName: targetVault,
    method: "POST",
    apiPath: "/api/internal/restore",
    verb: "admin",
    jsonBody: { source_vault: sourceVault, snapshot_key: snapshotKey },
  });
  if (!res.ok) throw new Error(`internal restore POST → HTTP ${res.status}`);
}
