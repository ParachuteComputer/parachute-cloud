/**
 * Review finding (T-318 day review 2, key b): D1 refuses a LIKE or GLOB
 * pattern longer than 50 bytes ("LIKE or GLOB pattern too complex";
 * developers.cloudflare.com/d1/platform/limits lists "Maximum characters
 * (bytes) in a LIKE or GLOB pattern: 50 bytes"). The test-pool D1 enforces the
 * same cap; it only fires when the LIKE is evaluated against at least one row,
 * so each test seeds a live token, as every production registry has.
 *
 * The vault delete cascade (`deleteVaultD1Rows`) pre-filtered with
 * `%vault:<name>:%`, the name plus 9 bytes, and vault names may be 63
 * characters (VAULT_SLUG_RE). So for any vault named 42+ characters:
 *   - the single-vault delete door erases the storage, then answers 500
 *     d1_cleanup_failed on every retry; the vault row and its tokens stay;
 *   - the account purge sweep throws for its owner on every pass (a throw is
 *     not a deferral: no attempt counted, no alert, never purged).
 */
import { env } from "cloudflare:test";
import { describe, expect, test, vi } from "vitest";
import { ACCOUNT_TOKEN_AUDIENCE } from "../src/account-auth.ts";
import { handleAccountVaultDelete } from "../src/account-api.ts";
import { DELETE_UNDO_WINDOW_MS, runAccountDeleteSweep } from "../src/account-delete.ts";
import { ACCOUNT_TOKEN_CLIENT_ID } from "../src/account-token.ts";
import type { OAuthDeps } from "../src/oauth-shared.ts";
import { signAccessToken } from "../src/tokens.ts";
import { getUserById } from "../src/users.ts";
import { getVault, VAULT_SLUG_RE } from "../src/vaults.ts";
import { ISSUER, deps, seedUser, seedVault } from "./helpers.ts";

type VaultFetch = NonNullable<OAuthDeps["vaultFetch"]>;
const okVault: VaultFetch = async (input, init) => {
  const req = new Request(input, init);
  if (new URL(req.url).pathname.endsWith("/api/internal/destroy")) {
    return Response.json({ destroyed: true, r2_objects_deleted: 0 });
  }
  return Response.json({ ok: true });
};

/** A legal vault name of exactly `len` characters. */
function longName(prefix: string, len: number): string {
  const name = (prefix + "-" + "x".repeat(len)).slice(0, len);
  expect(VAULT_SLUG_RE.test(name)).toBe(true);
  return name;
}

/** A live vault token row for the owner: what the cascade must revoke. */
async function seedVaultToken(jti: string, userId: string, vault: string): Promise<void> {
  const now = new Date();
  await env.DB
    .prepare(
      "INSERT INTO tokens (jti, user_id, client_id, scopes, expires_at, revoked_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)",
    )
    .bind(jti, userId, "like-cap-test", `vault:${vault}:read`, new Date(now.getTime() + 3600_000).toISOString(), now.toISOString())
    .run();
}

async function revokedAt(jti: string): Promise<string | null | undefined> {
  const row = await env.DB.prepare("SELECT revoked_at FROM tokens WHERE jti = ?").bind(jti).first<{ revoked_at: string | null }>();
  return row?.revoked_at;
}

describe("deleting a vault with a long (legal) name, on D1's 50-byte LIKE cap", () => {
  test("the single-vault delete door finishes for a 42-character name", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { id } = await seedUser("like-cap-door@example.com");
    const name = longName("door", 42);
    await seedVault(name, id);
    await seedVaultToken("like-cap-door-token", id, name);
    const { token } = await signAccessToken(env.DB, {
      sub: id,
      scopes: [`account:${id}:admin`],
      audience: ACCOUNT_TOKEN_AUDIENCE,
      clientId: ACCOUNT_TOKEN_CLIENT_ID,
      issuer: ISSUER,
      vaultScope: [],
      ttlSeconds: 600,
    });
    const res = await handleAccountVaultDelete(
      env.DB,
      new Request(`${ISSUER}/account/vaults/${name}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ confirm: name }),
      }),
      { ...deps(), vaultFetch: okVault },
    );
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await getVault(env.DB, name)).toBeNull();
    const revoked = await revokedAt("like-cap-door-token");
    // undefined = the token row is gone; the cascade must keep it, revoked.
    expect(revoked).toBeDefined();
    expect(revoked).not.toBeNull();
  });

  test("an account owning a 63-character vault is purged when its window closes", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { id } = await seedUser("like-cap-sweep@example.com");
    const name = longName("sweep", 63);
    await seedVault(name, id);
    await seedVaultToken("like-cap-sweep-token", id, name);
    const deletedAt = new Date(Date.now() - 2 * DELETE_UNDO_WINDOW_MS).toISOString();
    await env.DB.prepare("UPDATE users SET deleted_at = ?, delete_undo_hash = 'h' WHERE id = ?").bind(deletedAt, id).run();

    const summary = await runAccountDeleteSweep(env, { ...deps(), vaultFetch: okVault }, new Date(), { onlyUserId: id });
    expect(summary).toMatchObject({ purged: 1, failed: 0 });
    expect(await getUserById(env.DB, id)).toBeNull();
  });
});
