#!/usr/bin/env bun
/**
 * backfill-plans.ts — ONE-TIME Wave 4 backfill: set the comp accounts' plan +
 * push per-plan storage caps into every EXISTING vault DO (new vaults get
 * their cap at creation; this reconciles the pre-plans fleet).
 *
 * WHAT IT DOES (ratified 2026-07-02/03, cloud#55-era):
 *   1. Sets plan='parachute' for the comp accounts (COMP_EMAILS below —
 *      dev@parachute.computer + ag@unforced.org, Aaron's own accounts).
 *      Everyone else (test debris) stays 'free'.
 *   2. For EVERY vault, pushes the owner's plan cap into the DO via
 *      PUT /vault/<name>/api/internal/config — parachute owners → 10 GiB,
 *      free owners → 100 MB — then GETs it back to verify. A free-plan vault
 *      already holding >100 MB keeps ALL its data (reads/deletes unaffected);
 *      the cap only blocks byte-growing writes until it's under.
 *
 * HOW IT AUTHENTICATES: the operator's Cloudflare credential (wrangler) reads
 * the identity D1 — users, vaults, and the ACTIVE SIGNING KEY — and the script
 * mints the same first-party 2-minute `vault:<name>:admin` tokens the issuer's
 * own mint seam produces (workers/identity/scripts/sign-internal-token.ts).
 * Same trust root as the deploy pipeline; no new secrets, no test-only
 * endpoints in production.
 *
 * USAGE (from the repo root; wrangler must be logged into the account):
 *   bun scripts/backfill-plans.ts --dry-run          # staging, report only
 *   bun scripts/backfill-plans.ts                    # staging, apply
 *   TARGET=prod bun scripts/backfill-plans.ts --dry-run
 *   TARGET=prod bun scripts/backfill-plans.ts        # production, apply
 *
 * Idempotent: re-running re-asserts the same plans + caps.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PLAN_SPECS, coercePlanId, type PlanId } from "../workers/identity/src/plans.ts";
import { signInternalAdminToken } from "../workers/identity/scripts/sign-internal-token.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const IDENTITY_DIR = join(HERE, "..", "workers", "identity");
const ACCOUNT_ID = "8f2a7eb9d5e21ffa902a76cf62975c82"; // "Unforced Development" (same as deploy scripts)

/** Comp accounts (Aaron's own) — everyone else stays on 'free'. */
const COMP_EMAILS = ["dev@parachute.computer", "ag@unforced.org"];

const TARGETS = {
  staging: {
    db: "parachute-identity-staging",
    envFlags: ["--env", "staging"],
    issuer: "https://parachute-identity-staging.unforced.workers.dev",
    vaultOrigin: "https://parachute-vault-do-staging.unforced.workers.dev",
  },
  prod: {
    db: "parachute-identity",
    envFlags: ["--env", ""],
    issuer: "https://cloud.parachute.computer",
    vaultOrigin: "https://u.parachute.computer",
  },
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
  plan: string;
}
interface VaultRow {
  name: string;
  owner_user_id: string;
}
interface KeyRow {
  kid: string;
  private_key_pem: string;
}

function fmt(n: number): string {
  return n >= 1024 ** 3 ? `${n / 1024 ** 3} GiB` : `${Math.round(n / 1024 ** 2)} MB`;
}

async function main() {
  console.log(`backfill-plans → TARGET=${targetName}${DRY ? " (DRY RUN)" : ""}`);
  console.log(`  identity D1: ${target.db}   vaults: ${target.vaultOrigin}`);

  // 1. Comp the listed accounts.
  const users = d1<UserRow>("SELECT id, email, plan FROM users");
  const byId = new Map(users.map((u) => [u.id, u]));
  for (const email of COMP_EMAILS) {
    const user = users.find((u) => u.email.toLowerCase() === email.toLowerCase());
    if (!user) {
      console.log(`  comp ${email}: NOT PRESENT in ${targetName} — skipped`);
      continue;
    }
    if (user.plan === "parachute") {
      console.log(`  comp ${email}: already plan=parachute`);
      continue;
    }
    if (DRY) {
      console.log(`  comp ${email}: would set plan=parachute (currently ${user.plan})`);
    } else {
      d1(`UPDATE users SET plan = 'parachute' WHERE id = '${user.id.replace(/'/g, "''")}'`);
      console.log(`  comp ${email}: plan ${user.plan} → parachute`);
    }
    user.plan = "parachute"; // local view drives the cap pushes below
  }

  // 2. Push per-plan caps into every existing vault DO.
  const vaults = d1<VaultRow>("SELECT name, owner_user_id FROM vaults ORDER BY name");
  if (vaults.length === 0) {
    console.log("  no vaults — done.");
    return;
  }
  const keys = d1<KeyRow>(
    "SELECT kid, private_key_pem FROM signing_keys WHERE retired_at IS NULL ORDER BY created_at DESC LIMIT 1",
  );
  if (keys.length === 0) throw new Error("no active signing key in signing_keys — is the worker initialized?");
  const key = keys[0]!;

  let ok = 0;
  let failed = 0;
  for (const v of vaults) {
    const owner = byId.get(v.owner_user_id);
    const plan: PlanId = coercePlanId(owner?.plan);
    const cap = PLAN_SPECS[plan].total_bytes;
    const who = owner ? `${owner.email} plan=${plan}` : `ORPHAN owner ${v.owner_user_id} → free`;
    if (DRY) {
      console.log(`  vault ${v.name} (${who}): would set cap_bytes=${cap} (${fmt(cap)})`);
      continue;
    }
    const token = await signInternalAdminToken({
      privateKeyPem: key.private_key_pem,
      kid: key.kid,
      issuer: target.issuer,
      vaultName: v.name,
      sub: v.owner_user_id,
    });
    const url = `${target.vaultOrigin}/vault/${v.name}/api/internal/config`;
    const res = await fetch(url, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ cap_bytes: cap }),
    });
    const body = (await res.json().catch(() => ({}))) as { resolved_cap_bytes?: number };
    if (res.ok && body.resolved_cap_bytes === cap) {
      ok++;
      console.log(`  vault ${v.name} (${who}): cap_bytes=${cap} (${fmt(cap)}) — verified`);
    } else {
      failed++;
      console.error(`  vault ${v.name} (${who}): FAILED status=${res.status} body=${JSON.stringify(body)}`);
    }
  }

  console.log(DRY ? `\nDry run over ${vaults.length} vault(s). Nothing written.` : `\nDone: ${ok} set, ${failed} failed, ${vaults.length} total.`);
  if (failed > 0) process.exit(1);
}

await main();
