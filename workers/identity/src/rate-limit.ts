/**
 * Best-effort per-IP signup throttle. This is a DEV FENCE, not a security
 * control: it's a fixed-window counter in D1 keyed by CF-Connecting-IP.
 * Limitations (accepted for the no-payment beta):
 *   - an attacker rotating source IPs defeats it trivially;
 *   - the read→write is not transactional, so a burst of concurrent requests
 *     can slip a few past the limit;
 *   - the window is fixed (not sliding), so a caller can do `limit` at the end
 *     of one window and `limit` at the start of the next.
 * Real fences (email verification, Turnstile) are design §6 Phase 5.
 */

export const SIGNUP_WINDOW_MS = 60 * 60 * 1000; // 1 hour
// Generous enough for a shared NAT (an office, a household) + repeated dev
// smokes, tight enough to blunt a casual signup loop. Not a security number.
export const SIGNUP_MAX_PER_WINDOW = 20;

interface ThrottleRow {
  ip: string;
  attempts: number;
  window_started_at: string;
}

/** The client IP behind Cloudflare (falls back to a shared bucket if absent). */
export function clientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

/**
 * Register a signup attempt from `ip` and report whether it's allowed. Rolls the
 * window when it has elapsed. Returns `{ allowed, retryAfterSeconds }`.
 */
export async function checkAndBumpSignup(
  db: D1Database,
  ip: string,
  now: Date = new Date(),
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const row = await db.prepare("SELECT * FROM signup_throttle WHERE ip = ?").bind(ip).first<ThrottleRow>();
  const nowMs = now.getTime();
  if (!row) {
    await db
      .prepare("INSERT INTO signup_throttle (ip, attempts, window_started_at) VALUES (?, 1, ?)")
      .bind(ip, now.toISOString())
      .run();
    return { allowed: true, retryAfterSeconds: 0 };
  }
  const windowStart = new Date(row.window_started_at).getTime();
  const elapsed = nowMs - windowStart;
  if (elapsed >= SIGNUP_WINDOW_MS) {
    // Roll the window.
    await db
      .prepare("UPDATE signup_throttle SET attempts = 1, window_started_at = ? WHERE ip = ?")
      .bind(now.toISOString(), ip)
      .run();
    return { allowed: true, retryAfterSeconds: 0 };
  }
  if (row.attempts >= SIGNUP_MAX_PER_WINDOW) {
    return { allowed: false, retryAfterSeconds: Math.ceil((SIGNUP_WINDOW_MS - elapsed) / 1000) };
  }
  await db.prepare("UPDATE signup_throttle SET attempts = attempts + 1 WHERE ip = ?").bind(ip).run();
  return { allowed: true, retryAfterSeconds: 0 };
}

// --- login brute-force fence ----------------------------------------------

export const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
export const LOGIN_MAX_FAILURES = 5;

interface LoginRow {
  key: string;
  fails: number;
  window_started_at: string;
}

/** Per-(ip, email) key so a lockout can't be weaponized to lock a victim out globally. */
export function loginKey(ip: string, email: string): string {
  return `${ip}|${email.trim().toLowerCase()}`;
}

/**
 * Is this (ip, email) currently locked out? A locked key refuses even a correct
 * password until the window rolls — that's the brute-force fence. Returns the
 * retry-after so callers can surface it.
 */
export async function isLoginLocked(
  db: D1Database,
  key: string,
  now: Date = new Date(),
): Promise<{ locked: boolean; retryAfterSeconds: number }> {
  const row = await db.prepare("SELECT * FROM login_throttle WHERE key = ?").bind(key).first<LoginRow>();
  if (!row) return { locked: false, retryAfterSeconds: 0 };
  const elapsed = now.getTime() - new Date(row.window_started_at).getTime();
  if (elapsed >= LOGIN_WINDOW_MS) return { locked: false, retryAfterSeconds: 0 };
  if (row.fails >= LOGIN_MAX_FAILURES) {
    return { locked: true, retryAfterSeconds: Math.ceil((LOGIN_WINDOW_MS - elapsed) / 1000) };
  }
  return { locked: false, retryAfterSeconds: 0 };
}

/** Record a failed login attempt (rolls the window when it has elapsed). */
export async function recordLoginFailure(db: D1Database, key: string, now: Date = new Date()): Promise<void> {
  const row = await db.prepare("SELECT * FROM login_throttle WHERE key = ?").bind(key).first<LoginRow>();
  if (!row) {
    await db
      .prepare("INSERT INTO login_throttle (key, fails, window_started_at) VALUES (?, 1, ?)")
      .bind(key, now.toISOString())
      .run();
    return;
  }
  const elapsed = now.getTime() - new Date(row.window_started_at).getTime();
  if (elapsed >= LOGIN_WINDOW_MS) {
    await db
      .prepare("UPDATE login_throttle SET fails = 1, window_started_at = ? WHERE key = ?")
      .bind(now.toISOString(), key)
      .run();
  } else {
    await db.prepare("UPDATE login_throttle SET fails = fails + 1 WHERE key = ?").bind(key).run();
  }
}

/** Clear the failure counter on a successful login. */
export async function clearLoginFailures(db: D1Database, key: string): Promise<void> {
  await db.prepare("DELETE FROM login_throttle WHERE key = ?").bind(key).run();
}
