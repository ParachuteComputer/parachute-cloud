/**
 * Staging lives on its own Cloudflare account (T-432). scripts/staging-account.env is the one source; both
 * wrangler.toml [env.staging] blocks must agree with it, and production (the top level) must name no account at all,
 * or a staging key could reach production / a production deploy could aim at staging.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readStagingAccount, STAGING_IDENTITY, STAGING_VAULT } from "../scripts/staging-origins.ts";

const ROOT = join(import.meta.dir, "..");
const env = readStagingAccount();
const toml = (w: string) => Bun.TOML.parse(readFileSync(join(ROOT, "workers", w, "wrangler.toml"), "utf8")) as any;
const vault = toml("vault");
const identity = toml("identity");
const PROD_ACCOUNT = "d5d7c8646c3b69ce9f16bfd12ecbe98a";

describe("staging account", () => {
  test("both [env.staging] blocks pin the staging account; production names none", () => {
    expect(env.STAGING_ACCOUNT_ID).toMatch(/^[0-9a-f]{32}$/);
    expect(env.STAGING_ACCOUNT_ID).not.toBe(PROD_ACCOUNT);
    for (const t of [vault, identity]) {
      expect(t.env.staging.account_id).toBe(env.STAGING_ACCOUNT_ID);
      expect(t.account_id).toBeUndefined();
    }
  });

  test("the staging D1 and bucket are the env file's; production's are untouched", () => {
    const [d1] = identity.env.staging.d1_databases;
    expect(d1.database_name).toBe(env.STAGING_D1_NAME);
    expect(d1.database_id).toBe(env.STAGING_D1_ID);
    expect(identity.d1_databases[0].database_name).toBe("parachute-identity");
    expect(identity.d1_databases[0].database_id).not.toBe(env.STAGING_D1_ID);
    expect(vault.env.staging.r2_buckets[0].bucket_name).toBe(env.STAGING_R2_BUCKET);
    expect(vault.r2_buckets[0].bucket_name).toBe("parachute-vault");
  });

  test("every staging origin is on the staging account's workers.dev subdomain, and the two workers agree", () => {
    const sub = `.${env.STAGING_WORKERS_SUBDOMAIN}.workers.dev`;
    const iv = identity.env.staging.vars;
    const vv = vault.env.staging.vars;
    expect(iv.ISSUER).toBe(STAGING_IDENTITY);
    expect(iv.APP_ORIGIN).toBe(STAGING_IDENTITY);
    expect(iv.VAULT_ORIGIN).toBe(STAGING_VAULT);
    expect(iv.VAULT_BASE_DOMAIN).toBe(new URL(STAGING_VAULT).host);
    expect(vv.ISSUER_ORIGIN).toBe(iv.ISSUER);
    expect(vv.CONSOLE_PUBLIC_ORIGIN).toBe(iv.ISSUER);
    expect(vv.VAULT_BASE_DOMAIN).toBe(iv.VAULT_BASE_DOMAIN);
    for (const v of [iv.ISSUER, iv.VAULT_ORIGIN, vv.ISSUER_ORIGIN]) expect(new URL(v).host.endsWith(sub)).toBe(true);
    expect(identity.env.staging.routes).toEqual([]);
    expect(vault.env.staging.routes).toEqual([]);
  });

  test("no script or workflow still names the old staging host or aims staging at the production account", () => {
    const files = [
      ...readdirSync(join(ROOT, "scripts")).filter((f) => /\.(ts|sh|env)$/.test(f)).map((f) => join(ROOT, "scripts", f)),
      join(ROOT, "scripts", "release", "bunx"),
      join(ROOT, ".github", "workflows", "deploy-staging.yml"),
      join(ROOT, "workers", "vault", "wrangler.toml"),
      join(ROOT, "workers", "identity", "wrangler.toml"),
    ];
    const stale = files.filter((f) => readFileSync(f, "utf8").includes("openparachute.workers.dev"));
    expect(stale).toEqual([]);
    // The production id may appear only where production is meant.
    const prodOk = ["deploy-prod.sh", "staging-origins.ts"];
    const prodUsers = files.filter((f) => readFileSync(f, "utf8").includes(PROD_ACCOUNT)).map((f) => f.split("/").pop());
    expect(prodUsers.filter((f) => !prodOk.includes(f!))).toEqual([]);
  });
});
