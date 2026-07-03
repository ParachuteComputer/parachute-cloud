#!/usr/bin/env bun
/**
 * set-operator-role.ts — grant the operator role (Wave 4c /admin console) to
 * the named accounts. THE ONLY WRITER of users.role, deliberately: the admin
 * surface itself can comp and suspend but can never mint another operator —
 * that stays an out-of-band act by whoever holds the account's Cloudflare
 * credential (the same trust root as deploys; see migration 0011).
 *
 * OPERATOR_EMAILS below is the ratified list (Aaron's own accounts — the same
 * pair scripts/backfill-plans.ts comps). An email not present in the target
 * env's users table is reported and skipped, never created.
 *
 * HOW IT AUTHENTICATES: the operator's wrangler credential runs
 * `wrangler d1 execute` against the identity D1 — no tokens, no test-only
 * endpoints, same shape as backfill-plans.ts.
 *
 * USAGE (from the repo root; wrangler must be logged into the account):
 *   bun scripts/set-operator-role.ts --dry-run          # staging, report only
 *   bun scripts/set-operator-role.ts                    # staging, apply
 *   TARGET=prod bun scripts/set-operator-role.ts --dry-run
 *   TARGET=prod bun scripts/set-operator-role.ts        # production, apply
 *
 * Idempotent: re-running re-asserts the same roles. (Staging's dev user also
 * gets role='operator' from the deploy seed — seed-dev-user.ts — so a staging
 * re-deploy can never demote it; this script covers prod + the second email.)
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const IDENTITY_DIR = join(HERE, "..", "workers", "identity");
const ACCOUNT_ID = "8f2a7eb9d5e21ffa902a76cf62975c82"; // "Unforced Development" (same as deploy scripts)

/** The operator accounts (Aaron's own) — everyone else stays role='user'. */
const OPERATOR_EMAILS = ["dev@parachute.computer", "ag@unforced.org"];

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
const DRY = process.argv.includes("--dry-run");

function d1<T>(sql: string): T[] {
  const proc = Bun.spawnSync(
    ["bunx", "wrangler", "d1", "execute", target.db, "--remote", ...target.envFlags, "--json", "--command", sql],
    { cwd: IDENTITY_DIR, env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID } },
  );
  const stdout = proc.stdout.toString();
  if (proc.exitCode !== 0) {
    throw new Error(`wrangler d1 execute failed (${proc.exitCode}):\n${stdout}\n${proc.stderr.toString()}`);
  }
  // --json emits a JSON array of result envelopes; be tolerant of any banner.
  const raw = stdout.slice(stdout.indexOf("["), stdout.lastIndexOf("]") + 1);
  const parsed = JSON.parse(raw) as Array<{ results?: T[]; success?: boolean }>;
  const envelope = parsed[0];
  if (!envelope || envelope.success === false) throw new Error(`d1 execute unsuccessful: ${stdout}`);
  return envelope.results ?? [];
}

interface UserRow {
  id: string;
  email: string;
  role: string;
}

function main() {
  console.log(`set-operator-role → TARGET=${targetName}${DRY ? " (DRY RUN)" : ""}   identity D1: ${target.db}`);
  const users = d1<UserRow>("SELECT id, email, role FROM users");
  let set = 0;
  for (const email of OPERATOR_EMAILS) {
    const user = users.find((u) => u.email.toLowerCase() === email.toLowerCase());
    if (!user) {
      console.log(`  ${email}: NOT PRESENT in ${targetName} — skipped (never created here)`);
      continue;
    }
    if (user.role === "operator") {
      console.log(`  ${email}: already role=operator`);
      continue;
    }
    if (DRY) {
      console.log(`  ${email}: would set role=operator (currently ${user.role})`);
      continue;
    }
    d1(`UPDATE users SET role = 'operator' WHERE id = '${user.id.replace(/'/g, "''")}'`);
    set++;
    console.log(`  ${email}: role ${user.role} → operator`);
  }
  // Verify + report the full operator set (should only ever be the list above).
  const operators = d1<UserRow>("SELECT id, email, role FROM users WHERE role = 'operator'");
  console.log(`\n${DRY ? "Dry run — nothing written." : `Done: ${set} role(s) set.`} Operators in ${targetName}: ${operators.map((o) => o.email).join(", ") || "(none)"}`);
}

main();
