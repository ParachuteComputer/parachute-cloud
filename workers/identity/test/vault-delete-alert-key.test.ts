/**
 * The vault delete cascade drops the operator alert dedupe row that names the
 * vault (`internal-config-caps-malformed:<name>`, vault-call.ts). It matched
 * any key ENDING in `:<name>`, so a vault whose name is the tail of another
 * alert's key (`snapshot:failed`, `errors:5xx`, an account id in
 * `account-purge:<id>`) took that unrelated dedupe row with it, and the
 * operator was paged again before the hour was up (T-318 review 3).
 */
import { env } from "cloudflare:test";
import { expect, test } from "vitest";
import { deleteVaultD1Rows } from "../src/vaults.ts";
import { seedUser, seedVault } from "./helpers.ts";

test("deleting vault `failed` keeps the snapshot:failed alert's dedupe row", async () => {
  const { id } = await seedUser("alert-key@example.com");
  await seedVault("failed", id);
  const at = new Date().toISOString();
  for (const key of ["snapshot:failed", "internal-config-caps-malformed:failed"]) {
    await env.DB.prepare("INSERT INTO ops_alerts (key, last_alert_at) VALUES (?, ?)").bind(key, at).run();
  }

  await deleteVaultD1Rows(env.DB, id, "failed");

  const keys = (await env.DB.prepare("SELECT key FROM ops_alerts ORDER BY key").all<{ key: string }>()).results.map((r) => r.key);
  expect(keys).toEqual(["snapshot:failed"]);
});
