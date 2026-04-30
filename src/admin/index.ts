/**
 * Admin endpoints — operator-only handlers that kick reconciler passes.
 *
 * Auth: same shared bearer as `/api/dashboard` (`ADMIN_BEARER_SECRET`),
 * checked via constant-time compare. v1 single-key model; hardens to a
 * real session model when there's more than one operator.
 *
 * Routes:
 *   POST /api/admin/reconcile-tiers        → reconcileTierChanges
 *   POST /api/admin/reconcile-terminations → reconcileTerminations
 *   POST /api/admin/reconcile              → reconcileAll
 *
 * The same code path runs from the Cron Trigger (server.ts `scheduled`
 * handler) — the admin endpoints are the manual-kick equivalent for
 * operators driving the system from a CLI or curl.
 */

import type { Context } from "hono";
import type { Env } from "../env.ts";
import { type Db, db as makeDb } from "../db/client.ts";
import { FlyClient } from "../provider/fly-client.ts";
import type { ProviderClient } from "../provider/provider-client.ts";
import {
  reconcileAll,
  reconcileTerminations,
  reconcileTierChanges,
} from "../billing/reconcile.ts";

export interface AdminOverrides {
  db?: Db;
  provider?: ProviderClient;
}

export async function handleReconcileTiers(
  c: Context<{ Bindings: Env }>,
  overrides?: AdminOverrides,
): Promise<Response> {
  const guard = checkBearer(c);
  if (guard) return guard;
  const { db, provider } = resolveDeps(c, overrides);
  const tierChanges = await reconcileTierChanges(db, provider);
  return c.json({ ok: true, tierChanges });
}

export async function handleReconcileTerminations(
  c: Context<{ Bindings: Env }>,
  overrides?: AdminOverrides,
): Promise<Response> {
  const guard = checkBearer(c);
  if (guard) return guard;
  const { db, provider } = resolveDeps(c, overrides);
  const terminations = await reconcileTerminations(db, provider);
  return c.json({ ok: true, terminations });
}

export async function handleReconcileAll(
  c: Context<{ Bindings: Env }>,
  overrides?: AdminOverrides,
): Promise<Response> {
  const guard = checkBearer(c);
  if (guard) return guard;
  const { db, provider } = resolveDeps(c, overrides);
  const report = await reconcileAll(db, provider);
  return c.json({ ok: true, ...report });
}

function checkBearer(c: Context<{ Bindings: Env }>): Response | null {
  const auth = c.req.header("authorization") ?? "";
  const expected = `Bearer ${c.env.ADMIN_BEARER_SECRET}`;
  if (auth.length === 0 || !constantTimeEqual(auth, expected)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  return null;
}

function resolveDeps(
  c: Context<{ Bindings: Env }>,
  overrides: AdminOverrides | undefined,
): { db: Db; provider: ProviderClient } {
  const db = overrides?.db ?? makeDb(c.env.DB);
  const provider =
    overrides?.provider ??
    new FlyClient({ token: c.env.FLY_API_TOKEN, orgSlug: c.env.FLY_ORG_SLUG });
  return { db, provider };
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
