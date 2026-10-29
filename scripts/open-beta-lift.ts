#!/usr/bin/env bun
/**
 * open-beta-lift.ts — T-318 one-shot: move every trialing / frozen account onto
 * the clockless open beta (workers/identity/src/open-beta-lift.ts has the SQL,
 * the rules and the reasons; the real-D1 tests run the same statements).
 *
 * Paying subscribers and comps are COUNTED, never changed: nothing is
 * cancelled or refunded here. Tombstoned accounts are left alone.
 *
 * USAGE (repo root; wrangler logged into the Parachute account):
 *   TARGET=prod bun scripts/open-beta-lift.ts --dry-run           # COUNTS ONLY (the default)
 *   TARGET=prod bun scripts/open-beta-lift.ts --apply             # backup file, apply, counts after
 *   TARGET=prod bun scripts/open-beta-lift.ts --rollback <file>   # restore the backed-up rows
 * TARGET defaults to staging. LOCAL_PERSIST=<dir> runs against a LOCAL D1 in
 * <dir> instead of --remote (how the script itself was exercised; never touches
 * Cloudflare).
 *
 * OUTPUT: counts only. The --apply backup (user ids + plan columns, no emails)
 * goes to a local JSON file — keep it until the beta has settled; it is the
 * rollback's input. Never commit it.
 *
 * Idempotent: a second --apply finds 0 rows. The vaults' stored `frozen` flag
 * and voice entitlement are re-pushed by the 03:30 UTC usage reconciler (50
 * vaults/day); the vault worker already ignores `frozen` in open beta, so no
 * write is blocked in the meantime.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LIFT_APPLY_SQL,
  LIFT_BACKUP_SQL,
  LIFT_COUNTS_SQL,
  type LiftBackupRow,
  type LiftCounts,
  liftRollbackSql,
} from "../workers/identity/src/open-beta-lift.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const IDENTITY_DIR = join(HERE, "..", "workers", "identity");
const ACCOUNT_ID = "d5d7c8646c3b69ce9f16bfd12ecbe98a"; // same account as the deploy scripts

const TARGETS = {
  staging: { db: "parachute-identity-staging", envFlags: ["--env", "staging"] },
  prod: { db: "parachute-identity", envFlags: ["--env", ""] },
} as const;

const targetName = (process.env.TARGET ?? "staging") as keyof typeof TARGETS;
const target = TARGETS[targetName];
if (!target) {
  console.error(`Unknown TARGET "${targetName}" — use staging or prod.`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const rollbackIdx = argv.indexOf("--rollback");
const ROLLBACK = rollbackIdx >= 0 ? argv[rollbackIdx + 1] : undefined;
if (rollbackIdx >= 0 && !ROLLBACK) {
  console.error("--rollback needs the backup file written by --apply.");
  process.exit(1);
}
if (APPLY && ROLLBACK) {
  console.error("Pick one of --apply / --rollback.");
  process.exit(1);
}

const LOCAL_PERSIST = process.env.LOCAL_PERSIST;
const WHERE = LOCAL_PERSIST ? ["--local", "--persist-to", resolve(LOCAL_PERSIST)] : ["--remote"];

function wrangler(args: string[]): string {
  const proc = Bun.spawnSync(
    ["bunx", "wrangler", "d1", "execute", target.db, ...WHERE, ...target.envFlags, "--json", ...args],
    { cwd: IDENTITY_DIR, env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID } },
  );
  const stdout = proc.stdout.toString();
  if (proc.exitCode !== 0) {
    // stderr only — never echo row data.
    throw new Error(`wrangler d1 execute failed (${proc.exitCode}):\n${proc.stderr.toString()}`);
  }
  return stdout;
}

function query<T>(sql: string): T[] {
  const stdout = wrangler(["--command", sql]);
  const parsed = JSON.parse(stdout.slice(stdout.indexOf("["), stdout.lastIndexOf("]") + 1)) as Array<{
    results?: T[];
    success?: boolean;
  }>;
  const envelope = parsed[0];
  if (!envelope || envelope.success === false) throw new Error("d1 execute unsuccessful");
  return envelope.results ?? [];
}

/** Run statements from a temp file (wrangler --file). Row-change counts are
 *  NOT read from wrangler's output (local D1 doesn't report them); the before/
 *  after COUNTS are the audit trail. */
function execFile(statements: readonly string[]): void {
  const dir = mkdtempSync(join(tmpdir(), "open-beta-lift-"));
  const file = join(dir, "lift.sql");
  try {
    writeFileSync(file, statements.map((s) => (s.trim().endsWith(";") ? s : `${s};`)).join("\n"));
    const stdout = wrangler(["--file", file]);
    const parsed = JSON.parse(stdout.slice(stdout.indexOf("["), stdout.lastIndexOf("]") + 1)) as Array<{
      success?: boolean;
    }>;
    if (parsed.some((e) => e.success === false)) throw new Error("a statement reported success=false");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function counts(label: string): LiftCounts {
  const row = query<LiftCounts>(LIFT_COUNTS_SQL)[0];
  if (!row) throw new Error("counts query returned no row");
  console.log(`\n${label} (${targetName}, live accounts only):`);
  console.log(`  accounts                      ${row.accounts}`);
  console.log(`  trialing (plan=trial)         ${row.trialing}`);
  console.log(`    with a trial clock          ${row.trial_with_clock}`);
  console.log(`    trying Power (kept)         ${row.trial_trying_power}`);
  console.log(`  expired / frozen              ${row.expired_frozen}`);
  console.log(`    their vaults                ${row.frozen_vaults}`);
  console.log(`  paid, active subscription     ${row.paid_subscribers}   (left as they are)`);
  console.log(`    of which cancelling         ${row.paid_subscribers_cancelling}`);
  console.log(`  comped (paid, no Stripe)      ${row.comped}   (left as they are)`);
  console.log(`    with an end date            ${row.comped_with_end_date}`);
  console.log(`  unknown plan value            ${row.unknown_plan}`);
  console.log(`  rows the lift would change    ${row.to_lift}`);
  return row;
}

function main(): void {
  if (ROLLBACK) {
    const rows = JSON.parse(readFileSync(resolve(ROLLBACK), "utf8")) as LiftBackupRow[];
    const statements = liftRollbackSql(rows); // validates every value first
    if (statements.length === 0) {
      console.log("Backup is empty — nothing to roll back.");
      return;
    }
    execFile(statements);
    console.log(`Ran ${statements.length} guarded restores (a row that moved to a paid plan since is skipped).`);
    counts("After rollback");
    return;
  }

  const before = counts(APPLY ? "Before" : "DRY RUN — nothing changed");
  if (!APPLY) return;
  if (before.to_lift === 0) {
    console.log("\nNothing to lift.");
    return;
  }

  const backup = query<LiftBackupRow>(LIFT_BACKUP_SQL);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupFile = resolve(`open-beta-lift-backup-${targetName}-${stamp}.json`);
  writeFileSync(backupFile, `${JSON.stringify(backup, null, 2)}\n`);
  liftRollbackSql(backup); // prove the backup is restorable BEFORE changing anything
  console.log(`\nBackup of ${backup.length} rows → ${backupFile} (keep it; rollback input).`);

  execFile(LIFT_APPLY_SQL);
  console.log(`Applied the lift (${LIFT_APPLY_SQL.length} statements).`);
  counts("After");
}

main();
