/**
 * POST /api/internal/provision-complete — VM-to-control-plane callback.
 *
 * The bootstrap script on the user's Fly Machine calls this once it has
 * finished installing modules and dropped its marker. We:
 *   1. Validate the body has tenant_id + secret.
 *   2. Look up the row in `provisioning_secrets`. Reject when missing,
 *      expired, or mismatched (constant-time compare).
 *   3. Flip the matching account row to `active`.
 *   4. Delete the secret row — single-use, no replay.
 *
 * Auth model: the per-tenant secret IS the auth. There's no shared key
 * across tenants; loss of one secret can't be used against another.
 * Because the secret was generated control-plane-side and embedded in the
 * VM's env at machine-create time, only that VM (and any process inside
 * it) knows it.
 */

import type { Context } from "hono";
import { eq } from "drizzle-orm";
import type { Env } from "../env.ts";
import { type Db, db as makeDb } from "../db/client.ts";
import { accounts, provisioningSecrets } from "../db/schema.ts";

interface ProvisionCompleteBody {
  tenant_id?: unknown;
  secret?: unknown;
}

export async function handleProvisionComplete(
  c: Context<{ Bindings: Env }>,
  dbOverride?: Db,
): Promise<Response> {
  let body: ProvisionCompleteBody;
  try {
    body = (await c.req.json()) as ProvisionCompleteBody;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const tenantId = typeof body.tenant_id === "string" ? body.tenant_id : "";
  const secret = typeof body.secret === "string" ? body.secret : "";
  if (tenantId.length === 0 || secret.length === 0) {
    return c.json({ error: "missing_fields" }, 400);
  }

  const db = dbOverride ?? makeDb(c.env.DB);
  const row = await db.query.provisioningSecrets.findFirst({
    where: eq(provisioningSecrets.tenantId, tenantId),
  });
  // Single 401 body for every auth failure — missing row, bad secret,
  // or correct-but-expired secret all collapse to the same response so a
  // probe can't distinguish "wrong tenant" from "wrong secret" from
  // "expired" by reading the body. (A timing oracle still exists between
  // "row found, expiry checked" and "no row at all"; that's a deeper fix
  // — for now the constant-time-compare path runs unconditionally when
  // the row exists, so the only timing signal is row-existence, which is
  // already implied by tenant_id being a UUID we minted.)
  const expired = row ? Date.parse(row.expiresAt) < Date.now() : false;
  const matches = row ? constantTimeEqual(row.secret, secret) : false;
  if (!row || !matches || expired) {
    if (row && expired) {
      await db
        .delete(provisioningSecrets)
        .where(eq(provisioningSecrets.tenantId, tenantId));
    }
    return c.json({ error: "unauthorized" }, 401);
  }

  await db
    .update(accounts)
    .set({ status: "active" })
    .where(eq(accounts.id, tenantId));
  await db
    .delete(provisioningSecrets)
    .where(eq(provisioningSecrets.tenantId, tenantId));

  return c.json({ ok: true });
}

/**
 * Constant-time equality for two equal-length hex strings. Returns false
 * on length mismatch without leaking which side was longer.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
