/**
 * DEV-ONLY: generate the SQL that seeds one login user into the Identity
 * Worker's D1, from the gitignored `.dev-secrets`. Run with bun:
 *
 *   bun run seed:dev
 *
 * which runs this generator then applies `scripts/seed-dev-user.sql` to the
 * local D1 via wrangler. The PBKDF2 parameters here MUST match `src/users.ts`
 * (`pbkdf2$sha256$100000$<salt>$<derived>`) so the verifier accepts the hash.
 * deploy-staging.sh also runs it against the STAGING D1 (staging seeds the same
 * dev user + demo vault so smoke-staging.ts can log in).
 *
 * Never run against the PRODUCTION database (deploy-prod.sh deliberately has no
 * seed step): the INSERT OR REPLACE below would rotate the live operator
 * credentials as a deploy side effect.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// MUST match src/users.ts — workerd caps PBKDF2 at 100k iterations (a higher
// count writes an unverifiable hash on the deployed worker). See users.ts.
const PBKDF2_ITERATIONS = 100_000;

function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256,
  );
  return `pbkdf2$sha256$${PBKDF2_ITERATIONS}$${b64url(salt)}$${b64url(new Uint8Array(bits))}`;
}

function readSecrets(): { email: string; password: string } {
  const raw = readFileSync(join(HERE, "..", ".dev-secrets"), "utf8");
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const idx = t.indexOf("=");
    if (idx > 0) out[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
  }
  const email = out.DEV_USER_EMAIL;
  const password = out.DEV_USER_PASSWORD;
  if (!email || !password) throw new Error("`.dev-secrets` must define DEV_USER_EMAIL and DEV_USER_PASSWORD");
  return { email, password };
}

// A STABLE dev-user id (not randomUUID): re-seeding must not change the id, or
// it orphans the grandfathered `demo` vault ownership + any dev tokens/sessions.
const DEV_USER_ID = "0de1d1de-c0de-4000-8000-000000000001";

const { email, password } = readSecrets();
const passwordHash = await hashPassword(password);
const createdAt = new Date().toISOString();
const esc = (s: string) => s.replace(/'/g, "''");

// Grandfather the existing `demo` vault (used by scripts/smoke-staging.ts +
// TRYIT) to the dev user. `demo` is a RESERVED name (vaults.ts) so it can't be
// claimed via the console — this seed is the only way it gets an owner, which
// keeps the smoke's demo vault mintable now that ownership is enforced. A migration
// can't do this: the dev user's id isn't known at migration time (migrations run
// before this seed on the deployed D1).
// email_verified = 1: the dev address is known/owned, and INSERT OR REPLACE would
// otherwise reset it to the column default (0) on every re-seed.
// plan = 'standard': the dev/operator account is a comp (matching the
// scripts/backfill-plans.ts comp list — the parachute→standard rename). The
// seed runs AFTER migration 0018, so it must write a NEW plan id ('parachute'
// would coerce to the 'expired' floor). INSERT OR REPLACE would otherwise reset
// it to the column default on every re-seed.
// role = 'operator': the dev account IS the operator login (/admin —
// smoke-staging.ts asserts it sees the console) — INSERT OR REPLACE would
// otherwise reset it to 'user' on every re-seed. suspended_at stays unnamed
// (→ NULL default): a re-seed never leaves the operator suspended.
const sql = `-- DEV-ONLY generated seed — do not commit. Regenerate with \`bun run seed:dev\`.
INSERT OR REPLACE INTO users (id, email, password_hash, created_at, email_verified, plan, role)
VALUES ('${esc(DEV_USER_ID)}', '${esc(email)}', '${esc(passwordHash)}', '${esc(createdAt)}', 1, 'standard', 'operator');
INSERT OR REPLACE INTO vaults (name, owner_user_id, created_at)
VALUES ('demo', '${esc(DEV_USER_ID)}', '${esc(createdAt)}');
`;
writeFileSync(join(HERE, "seed-dev-user.sql"), sql);
console.log(`Wrote scripts/seed-dev-user.sql for user ${email} (owns vault "demo")`);
