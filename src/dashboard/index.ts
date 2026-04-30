/**
 * GET /api/dashboard — operator-only fleet view.
 *
 * Returns a JSON list of every tenant row with its lifecycle status, fly
 * handle, and tier. Never includes user data — this is just metadata.
 *
 * Authn: shared bearer secret (`ADMIN_BEARER_SECRET`) for v1. Hardens to
 * a real session model when there's more than one operator.
 */

import type { Context } from "hono";
import type { Env } from "../env.ts";
import { type Db, db as makeDb } from "../db/client.ts";
import { accounts } from "../db/schema.ts";

export async function handleDashboard(
  c: Context<{ Bindings: Env }>,
  dbOverride?: Db,
): Promise<Response> {
  const auth = c.req.header("authorization") ?? "";
  const expected = `Bearer ${c.env.ADMIN_BEARER_SECRET}`;
  if (auth.length === 0 || !constantTimeEqual(auth, expected)) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const db = dbOverride ?? makeDb(c.env.DB);
  const rows = await db.select().from(accounts);
  return c.json({
    accounts: rows.map((row) => ({
      id: row.id,
      email: row.email,
      tier: row.tier,
      status: row.status,
      flyAppName: row.flyAppName,
      flyMachineId: row.flyMachineId,
      createdAt: row.createdAt,
    })),
  });
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
