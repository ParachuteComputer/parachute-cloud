/**
 * Per-vault per-day API rate limiter backed by Workers KV.
 *
 * Key shape: `rl:<vaultId>:<YYYY-MM-DD-UTC>`.
 * Value:     integer count, UTF-8 decimal.
 * TTL:       one day (midnight UTC rollover gives us a fresh key automatically).
 *
 * This is a soft cap. Reads and writes race at the KV layer — two concurrent
 * requests can each read `N`, each write `N+1`, and the cap can be exceeded
 * by a small amount. That's fine at the volumes we care about. If we ever
 * need exact enforcement, a DO-backed counter is the upgrade path.
 *
 * The limit comes from `tierOf(tier).mcpRequestsPerDay`. The name is a
 * holdover — in practice it gates every `/api/*` request on the vault
 * subdomain, not just MCP traffic.
 */

import type { Env } from "./env.js";
import { tierOf, type TierId } from "./billing/tiers.js";

export interface RateLimitResult {
  allowed: boolean;
  /** Remaining requests in the current window (>=0). */
  remaining: number;
  /** Per-day cap. */
  limit: number;
  /** Seconds from now until the window rolls over (midnight UTC). */
  retryAfter: number;
}

function utcDayKey(now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function secondsUntilUtcMidnight(now: Date): number {
  const next = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
  );
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

export async function checkAndIncrement(
  env: Env,
  vaultId: string,
  tier: TierId,
): Promise<RateLimitResult> {
  const limit = tierOf(tier).mcpRequestsPerDay;
  const now = new Date();
  const key = `rl:${vaultId}:${utcDayKey(now)}`;
  const retryAfter = secondsUntilUtcMidnight(now);

  // Fail OPEN on KV errors. The module docstring calls this a soft cap; a KV
  // outage should not take down the paid API surface. If `get` throws, we
  // treat the current count as zero; if `put` throws, we still allow.
  let count = 0;
  try {
    const raw = await env.RATE_LIMIT_KV.get(key);
    const current = raw ? Number.parseInt(raw, 10) : 0;
    count = Number.isFinite(current) && current >= 0 ? current : 0;
  } catch {
    return { allowed: true, remaining: limit, limit, retryAfter };
  }

  if (count >= limit) {
    return { allowed: false, remaining: 0, limit, retryAfter };
  }

  const next = count + 1;
  try {
    // 25h TTL — KV's minimum is 60s and we want the key to survive long enough
    // for the day boundary to re-key rather than racing an expiry.
    await env.RATE_LIMIT_KV.put(key, String(next), { expirationTtl: 60 * 60 * 25 });
  } catch {
    // KV write failure — request was already below the cap, so allow.
  }

  return { allowed: true, remaining: Math.max(0, limit - next), limit, retryAfter };
}

export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    "X-RateLimit-Limit": String(result.limit),
    "X-RateLimit-Remaining": String(result.remaining),
    ...(result.allowed ? {} : { "Retry-After": String(result.retryAfter) }),
  };
}
