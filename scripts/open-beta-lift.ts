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
import { readFileSync, writeFileSync } from "node:fs";
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
import { PROD_ACCOUNT_ID, STAGING_ACCOUNT_ID } from "./staging-origins.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const IDENTITY_DIR = join(HERE, "..", "workers", "identity");

const TARGETS = {
  staging: { db: "parachute-identity-staging", envFlags: ["--env", "staging"], account: STAGING_ACCOUNT_ID },
  prod: { db: "parachute-identity", envFlags: ["--env", ""], account: PROD_ACCOUNT_ID },
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
    { cwd: IDENTITY_DIR, env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: target.account } },
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

/** Run statements through `--command` (D1's /query API), in order. NOT
 *  `--file`: wrangler sends a remote `--file` to D1's /import API, which the
 *  scoped deploy key refuses (401, code 10000; T-413); /query is the path
 *  `d1 migrations apply` uses. Statements are packed into commands of at most
 *  MAX_COMMAND_BYTES and MAX_COMMAND_STATEMENTS (well under Linux's 128 KiB
 *  argv-string limit and D1's 100 KB SQL limit), so a large rollback runs as
 *  several commands. Unlike the old /import, the run is NOT all-or-nothing:
 *  every statement here is guarded and idempotent, so a failed run is safe to
 *  re-run, and a failure names how many commands had already committed.
 *  Row-change counts are NOT read from wrangler's output (local D1 doesn't
 *  report them); the before/after COUNTS are the audit trail. */
const MAX_COMMAND_BYTES = 30_000;
const MAX_COMMAND_STATEMENTS = 50;
function packStatements(statements: readonly string[]): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let curBytes = 0;
  for (const raw of statements) {
    const s = raw.trim().endsWith(";") ? raw.trim() : `${raw.trim()};`;
    const bytes = Buffer.byteLength(s) + 1;
    if (bytes > MAX_COMMAND_BYTES) throw new Error(`a statement is over ${MAX_COMMAND_BYTES} bytes`);
    if (cur.length && (curBytes + bytes > MAX_COMMAND_BYTES || cur.length >= MAX_COMMAND_STATEMENTS)) {
      out.push(cur.join("\n"));
      cur = [];
      curBytes = 0;
    }
    cur.push(s);
    curBytes += bytes;
  }
  if (cur.length) out.push(cur.join("\n"));
  return out;
}

function execStatements(statements: readonly string[]): number {
  const commands = packStatements(statements);
  commands.forEach((command, i) => {
    try {
      const stdout = wrangler(["--command", command]);
      const parsed = JSON.parse(stdout.slice(stdout.indexOf("["), stdout.lastIndexOf("]") + 1)) as Array<{
        success?: boolean;
      }>;
      if (parsed.some((e) => e.success === false)) throw new Error("a statement reported success=false");
    } catch (err) {
      throw new Error(
        `command ${i + 1} of ${commands.length} failed; the ${i} before it committed. Every statement is guarded, ` +
          `so re-run the same command (keep any backup file already written).\n${(err as Error).message}`,
      );
    }
  });
  return commands.length;
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
    const commands = execStatements(statements);
    console.log(`Ran ${statements.length} guarded restores in ${commands} wrangler command(s) (a row that moved to a paid plan since is skipped).`);
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

  execStatements(LIFT_APPLY_SQL);
  console.log(`Applied the lift (${LIFT_APPLY_SQL.length} statements).`);
  counts("After");
}

main();
