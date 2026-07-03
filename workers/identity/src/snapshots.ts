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
 *   - Failure posture mirrors the usage rollup: one vault's failed snapshot
 *     logs `event=snapshot_failed` (vault name only, PII-free) and the run
 *     CONTINUES — it self-heals the next night, and the GFS ranks are
 *     calendar-based so a missed night never corrupts the rotation. Bounded
 *     by {@link SNAPSHOT_RUN_CAP}; injectable clock via deps.
 *
 *   - Restore orchestration helpers for the console (console.ts
 *     handleRestorePost): target-name derivation + the internal restore
 *     call. Restore NEVER touches the source vault — it creates (or, for a
 *     same-day retry, reuses) `<vault>-restored-<date>` and replays the
 *     tarball into THAT.
 */
import type { Env } from "./env.ts";
import type { OAuthDeps } from "./oauth-shared.ts";
import { PLAN_SPECS, coercePlanId, type SnapshotRetention } from "./plans.ts";
import { callVaultApi } from "./vault-call.ts";

/**
 * Per-run bound on vault snapshots — same rationale + growth note as
 * USAGE_RUN_CAP (usage.ts): current fleets are tiny; paginate by name cursor
 * (or fan out via a queue) before raising this.
 */
export const SNAPSHOT_RUN_CAP = 500;

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
}

/**
 * One nightly tick: snapshot every vault under its owner's plan policy and
 * mirror each returned manifest into D1. `opts.runCap` exists only for tests.
 */
export async function runSnapshotSweep(
  env: Env,
  deps: OAuthDeps,
  opts: { runCap?: number } = {},
): Promise<SnapshotSweepSummary> {
  const runCap = opts.runCap ?? SNAPSHOT_RUN_CAP;
  const now = deps.now?.() ?? new Date();
  const day = now.toISOString().slice(0, 10);

  const res = await env.DB.prepare(
    `SELECT v.name, v.owner_user_id, u.plan FROM vaults v JOIN users u ON u.id = v.owner_user_id ORDER BY v.name LIMIT ?`,
  )
    .bind(runCap + 1)
    .all<{ name: string; owner_user_id: string; plan: string }>();
  const rows = res.results ?? [];
  const capped = rows.length > runCap;
  const vaults = capped ? rows.slice(0, runCap) : rows;
  if (capped) console.error(`event=snapshot_sweep_capped cap=${runCap} — paginate before raising (see SNAPSHOT_RUN_CAP note)`);

  let taken = 0;
  let skipped = 0;
  let failed = 0;
  for (const v of vaults) {
    try {
      const retention: SnapshotRetention = PLAN_SPECS[coercePlanId(v.plan)].snapshot_retention;
      const resp = await callVaultApi(env.DB, deps, {
        userId: v.owner_user_id,
        vaultName: v.name,
        method: "POST",
        apiPath: "/api/internal/snapshot",
        verb: "admin",
        jsonBody: { retention },
      });
      if (!resp.ok) throw new Error(`internal snapshot POST → HTTP ${resp.status}`);
      const body = (await resp.json()) as { skipped?: unknown; manifest?: unknown };
      if (typeof body.skipped !== "boolean" || !Array.isArray(body.manifest)) {
        throw new Error("internal snapshot POST carried no run shape (skipped/manifest)");
      }
      body.skipped ? skipped++ : taken++;
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

  const summary: SnapshotSweepSummary = { day, vaults: vaults.length, taken, skipped, failed, capped };
  console.log(
    `event=snapshot_sweep day=${day} vaults=${summary.vaults} taken=${taken} skipped=${skipped} failed=${failed} capped=${capped}`,
  );
  return summary;
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
