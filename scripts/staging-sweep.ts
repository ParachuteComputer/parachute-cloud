#!/usr/bin/env bun
/**
 * staging-sweep.ts — delete DEBRIS vaults left behind by the live smoke test
 * (scripts/smoke-staging.ts) from STAGING's D1 `vaults` table.
 *
 * WHY (cloud#166): the smoke creates a handful of throwaway vaults on EVERY
 * run and never cleans them up; staging had grown to ~140 by 2026-07-17. The
 * nightly GFS snapshot sweep (SNAPSHOT_CRON) and the smoke's OWN snapshot →
 * R2 → new-DO-import restore round trip (scripts/smoke-staging.ts §17) both
 * enumerate every vault the D1 `vaults` table knows about — as the fleet
 * grows, that round trip got slow enough to cross the smoke's client-side
 * fetch timeout (2 consecutive staging runs failed there). This script
 * shrinks the fleet back down; it is a manual lever, not a fix for the
 * timeout itself (that's the generous explicit timeout added in the same
 * PR, scripts/smoke-staging.ts §17).
 *
 * WHAT IT ACTUALLY DELETES: only the D1 OWNERSHIP ROW (`vaults.name`) for
 * vaults matching the smoke's own throwaway prefixes, older than the cutoff.
 * A REAL teardown verb now exists (cloud#226): `vault-do.ts`'s
 * `POST /api/internal/destroy` purges the DO storage + the whole
 * `vault-<name>/` R2 prefix, and `DELETE /account/vaults/:name`
 * (account-api.ts) drives it plus the identity-side D1 sweep. THIS SCRIPT
 * STILL DOES NEITHER — its trust root is the operator's own wrangler
 * credential against D1, not a minted account bearer, so the underlying DO
 * SQLite storage + any R2 objects are left ORPHANED, not reclaimed. Porting
 * this lever onto the real delete door is separate work. That's an
 * acceptable trade for what this script is FOR: the debris problem is the D1
 * `vaults` COUNT (what the console lists, what the usage/snapshot crons
 * enumerate, what the vault-count cap counts against, and what the nightly
 * sweep + the smoke's own restore round trip iterate over) — a hibernated,
 * unowned, orphaned DO with a handful of smoke notes bills near-zero storage
 * and is no longer reachable by name once its D1 row is gone. A real
 * teardown verb (DO storage + R2 purge) is separate, larger work — track it
 * against cloud#166 if the orphaned storage itself ever becomes a problem.
 *
 * STAGING ONLY, STRUCTURALLY — unlike scripts/backfill-plans.ts /
 * scripts/set-operator-role.ts, this script has NO `TARGET=prod` escape
 * hatch: the D1 database name + env flags below are hardcoded to staging's,
 * full stop, plus a defense-in-depth assertion refuses to run if that name
 * doesn't contain "staging". OPERATOR-RUN ONLY — this is never invoked by
 * any CI/deploy workflow (grep .github/workflows for confirmation before
 * changing that) and never should be.
 *
 * HOW IT AUTHENTICATES: the operator's own Cloudflare credential runs
 * `wrangler d1 execute --remote` against the staging identity D1 — no
 * secrets minted, no test-only endpoints — the same pattern
 * scripts/set-operator-role.ts uses (this is the "admin/first-party path":
 * an operator's own credential is the trust root, same as deploys).
 *
 * NEVER deletes the literal name "demo" regardless of age/prefix match — the
 * grandfathered dev-user vault every smoke run depends on.
 *
 * USAGE (from the repo root; wrangler must be logged into the account):
 *   bun scripts/staging-sweep.ts                  # dry run — lists candidates
 *   bun scripts/staging-sweep.ts --yes             # deletes vaults older than 1 day
 *   bun scripts/staging-sweep.ts --yes --days=7    # override the age cutoff
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const IDENTITY_DIR = join(HERE, "..", "workers", "identity");
const ACCOUNT_ID = "d5d7c8646c3b69ce9f16bfd12ecbe98a"; // new Parachute account (same as deploy scripts)

// Hardcoded to STAGING — no env-var override. This IS the guard: the script
// is structurally incapable of naming production's D1 database.
const STAGING_DB = "parachute-identity-staging";
const STAGING_ENV_FLAGS = ["--env", "staging"];
if (!STAGING_DB.includes("staging")) {
  // Defense-in-depth against an accidental future edit to the constant above.
  throw new Error("refusing to run: STAGING_DB does not look like a staging database");
}

// The smoke's own throwaway vault-name prefixes (scripts/smoke-staging.ts) —
// every vault it mints starts with one of these (including restore targets:
// "<arrivalVault>-restored-<date>" already starts with "arrive-"). Keep in
// sync with the smoke; a new smoke section that mints a new prefix should
// add it here too. (scripts/cost-proof-ws-hibernation.ts is a SEPARATE,
// standalone live-cost-proof script with its own "cost*" throwaway vaults —
// out of scope here, not part of the smoke this script targets.)
const THROWAWAY_PREFIXES = [
  "box-", // §9 console signup / ownership-refusal
  "imp-", // §9 console IMPORT door round-trip
  "arrive-", // guided-arrival walk (also covers its "<name>-restored-<date>" targets)
  "tierbox-", // tier/plan-change section
  "mockbox-", // mock-upgrade → voice E2E
  "enforcebox-", // plan-enforcement (Entry frozen/attachments) section
];
const NEVER_DELETE = new Set(["demo"]); // the grandfathered dev-user vault

const DAYS = Number(process.argv.find((a) => a.startsWith("--days="))?.slice("--days=".length) ?? "1");
const APPLY = process.argv.includes("--yes");

function d1<T>(sql: string): T[] {
  const proc = Bun.spawnSync(
    ["bunx", "wrangler", "d1", "execute", STAGING_DB, "--remote", ...STAGING_ENV_FLAGS, "--json", "--command", sql],
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

interface VaultRow {
  name: string;
  created_at: string;
}

function main() {
  const cutoff = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000).toISOString();
  console.log(
    `staging-sweep → db=${STAGING_DB} cutoff=${cutoff} (older than ${DAYS}d)${APPLY ? "" : " — DRY RUN (pass --yes to apply)"}`,
  );

  const prefixWhere = THROWAWAY_PREFIXES.map((p) => `name LIKE '${p.replace(/'/g, "''")}%'`).join(" OR ");
  const rows = d1<VaultRow>(
    `SELECT name, created_at FROM vaults WHERE (${prefixWhere}) AND created_at < '${cutoff}' ORDER BY created_at`,
  );
  const candidates = rows.filter((r) => !NEVER_DELETE.has(r.name));

  if (candidates.length === 0) {
    console.log("No debris vaults matched — nothing to do.");
    return;
  }
  console.log(`${candidates.length} candidate(s):`);
  for (const r of candidates) console.log(`  ${r.name}  (created ${r.created_at})`);

  if (!APPLY) {
    console.log("\nDry run — nothing deleted. Re-run with --yes to apply.");
    return;
  }

  let deleted = 0;
  for (const r of candidates) {
    d1(`DELETE FROM vaults WHERE name = '${r.name.replace(/'/g, "''")}'`);
    deleted++;
  }
  console.log(
    `\nDeleted ${deleted} D1 vault ownership row(s). Their Durable Object storage (+ any R2 attachments) is ORPHANED, not reclaimed — see the file header.`,
  );
}

main();
