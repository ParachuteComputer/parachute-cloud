/**
 * RateLimiterDO — the Durable-Object rate limiter behind the login/signup/
 * magic-link abuse fences (#30). ONE DO instance per rate key (`signup:<ip>`,
 * `login:<ip>|<email>`, `magic:<ip>|<email>` — `idFromName` in rate-limit.ts),
 * so the DO serializes every update for its key. That gives the two properties
 * the old best-effort D1 fences couldn't: an ATOMIC read→write (no
 * concurrent-burst slip-through past the limit) and a true SLIDING window
 * (event timestamps in DO SQLite, pruned as they age) instead of a fixed
 * window that fully resets on roll.
 *
 * POLICY (windows/limits) lives in rate-limit.ts — unchanged from the D1
 * fences this replaces. This class is a generic sliding-window counter:
 * `windowMs`/`max` arrive per call. Every fence — signup, magic-link send and
 * the sign-in guess lockouts — checks and records in ONE call
 * (`checkAndBump`), so a parallel burst can't slip past the limit between a
 * check and a record (T-419). Callers choose the outage posture (rate-limit.ts).
 *
 * Cleanup: every write re-arms a purge alarm at REAL-now + window (+ slack).
 * When it fires, every recorded event is at least a full window old (the alarm
 * is always ≥ the newest write's real time + window; alarms never fire early),
 * so the table empties and the idle DO's storage returns to ~zero.
 */
import { DurableObject } from "cloudflare:workers";
import type { BumpOutcome } from "./rate-limit.ts";

const PURGE_SLACK_MS = 60_000;

export class RateLimiterDO extends DurableObject<unknown> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // One tiny table per key-DO: the live event timestamps inside the window.
    this.sql.exec("CREATE TABLE IF NOT EXISTS events (ts INTEGER NOT NULL)");
  }

  /**
   * Register an event (signup attempt, magic-link send, sign-in guess) and
   * report whether it is allowed under `max` events per sliding `windowMs`. A denied call
   * records NOTHING (being blocked never extends the block — same as the D1
   * fences). `nowMs` comes from the caller so tests can inject a clock.
   */
  async checkAndBump(windowMs: number, max: number, nowMs: number): Promise<BumpOutcome> {
    this.prune(nowMs, windowMs);
    const lift = this.liftTs(max);
    if (lift !== null) return { allowed: false, retryAfterSeconds: retryAfter(lift, windowMs, nowMs) };
    this.sql.exec("INSERT INTO events (ts) VALUES (?)", nowMs);
    await this.armPurgeAlarm(windowMs);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /**
   * DEPRECATED (T-419) — the previous worker version's separate check and
   * record calls. Kept for ONE release so isolates still on that version during
   * deploy propagation keep a working fence instead of erroring (their client
   * failed open on errors). Nothing in this version calls them; remove next
   * release.
   */
  async isLocked(windowMs: number, max: number, nowMs: number): Promise<{ locked: boolean; retryAfterSeconds: number }> {
    this.prune(nowMs, windowMs);
    const lift = this.liftTs(max);
    if (lift === null) return { locked: false, retryAfterSeconds: 0 };
    return { locked: true, retryAfterSeconds: retryAfter(lift, windowMs, nowMs) };
  }

  /** DEPRECATED (T-419) — see {@link isLocked}; remove next release. */
  async recordFailure(windowMs: number, nowMs: number): Promise<void> {
    this.prune(nowMs, windowMs);
    this.sql.exec("INSERT INTO events (ts) VALUES (?)", nowMs);
    await this.armPurgeAlarm(windowMs);
  }

  /** Clear every event for this key (successful login clears the fence). */
  async clear(): Promise<void> {
    this.sql.exec("DELETE FROM events");
  }

  /** Purge alarm: by the invariant in the header every event has aged out. */
  async alarm(): Promise<void> {
    this.sql.exec("DELETE FROM events");
  }

  private prune(nowMs: number, windowMs: number): void {
    this.sql.exec("DELETE FROM events WHERE ts <= ?", nowMs - windowMs);
  }

  /**
   * When (post-prune) the window already holds ≥ `max` events, return the
   * timestamp whose expiry lifts the limit — the (count − max + 1)-th oldest
   * event (once it ages out, fewer than `max` remain). Null → under the limit.
   */
  private liftTs(max: number): number | null {
    const count = Number(this.sql.exec("SELECT COUNT(*) AS n FROM events").one().n);
    if (count < max) return null;
    const row = this.sql.exec("SELECT ts FROM events ORDER BY ts LIMIT 1 OFFSET ?", count - max).one();
    return Number(row.ts);
  }

  /**
   * Re-arm the purge alarm from the REAL clock (never the caller-injected
   * `nowMs`): tests inject fixed timestamps, and an alarm computed from those
   * could land in the past and wipe events mid-test. Real-now + window + slack
   * preserves the header's "everything has aged out when it fires" invariant.
   */
  private async armPurgeAlarm(windowMs: number): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + windowMs + PURGE_SLACK_MS);
  }
}

function retryAfter(liftTs: number, windowMs: number, nowMs: number): number {
  return Math.max(1, Math.ceil((liftTs + windowMs - nowMs) / 1000));
}
