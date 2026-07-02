/**
 * DEV-ONLY: generate the SQL that seeds one login user into the Identity
 * Worker's D1, from the gitignored `.dev-secrets`. Run with bun:
 *
 *   bun run seed:dev
 *
 * which runs this generator then applies `scripts/seed-dev-user.sql` to the
 * local D1 via wrangler. The PBKDF2 parameters here MUST match `src/users.ts`
 * (`pbkdf2$sha256$210000$<salt>$<derived>`) so the verifier accepts the hash.
 *
 * Never run against a production database — this is a local-dev convenience for
 * exercising the browser login + consent flow against a real client.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PBKDF2_ITERATIONS = 210_000;

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

const { email, password } = readSecrets();
const passwordHash = await hashPassword(password);
const id = crypto.randomUUID();
const createdAt = new Date().toISOString();
const esc = (s: string) => s.replace(/'/g, "''");

const sql = `-- DEV-ONLY generated seed — do not commit. Regenerate with \`bun run seed:dev\`.
INSERT OR REPLACE INTO users (id, email, password_hash, created_at)
VALUES ('${esc(id)}', '${esc(email)}', '${esc(passwordHash)}', '${esc(createdAt)}');
`;
writeFileSync(join(HERE, "seed-dev-user.sql"), sql);
console.log(`Wrote scripts/seed-dev-user.sql for user ${email}`);
