/**
 * Abuse-fence policy + the fail-open client for {@link RateLimiterDO} (#30).
 *
 * The counters live in a Durable Object — one instance per rate key, which
 * serializes updates (atomic read→write, no concurrent-burst slip-through) and
 * implements a true SLIDING window. This file owns the POLICY (the same
 * windows/limits as the retired D1 fences — see migrations/0006) and the key
 * derivation, and wraps every DO call in the availability posture:
 *
 * FAIL OPEN. If the Durable Object errors or is unreachable, the request is
 * ALLOWED (and lockout checks report unlocked) with a structured
 * `event=rate_limiter_unavailable` log line — availability over strictness,
 * the same posture the best-effort D1 fences had. The log line is PII-free by
 * design: the op name only, never the key (keys carry ip/email).
 *
 * These are still abuse FENCES, not full security controls: an attacker
 * rotating source IPs walks around any IP-keyed limit. Real bot fences
 * (Turnstile, email verification) remain design §6 Phase 5 (cloud#48).
 */

export interface BumpOutcome {
  allowed: boolean;
  retryAfterSeconds: number;
}
export interface LockOutcome {
  locked: boolean;
  retryAfterSeconds: number;
}

/**
 * Structural view of the RATE_LIMITER binding (typed here rather than as
 * `DurableObjectNamespace<RateLimiterDO>` so tests can hand the client a fake
 * namespace — the fail-open tests inject one whose stub always throws).
 */
export interface RateLimiterNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): RateLimiterStub;
}
interface RateLimiterStub {
  checkAndBump(windowMs: number, max: number, nowMs: number): Promise<BumpOutcome>;
  isLocked(windowMs: number, max: number, nowMs: number): Promise<LockOutcome>;
  recordFailure(windowMs: number, nowMs: number): Promise<void>;
  clear(): Promise<void>;
}

function stubFor(limiter: RateLimiterNamespace, key: string): RateLimiterStub {
  return limiter.get(limiter.idFromName(key));
}

/** PII-free unavailability trail (op only — keys carry ip/email, never log them). */
function failOpen(op: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`event=rate_limiter_unavailable op=${op} error=${JSON.stringify(msg)}`);
}

// --- signup fence ------------------------------------------------------------

export const SIGNUP_WINDOW_MS = 60 * 60 * 1000; // 1 hour
// Generous enough for a shared NAT (an office, a household) + repeated dev
// smokes, tight enough to blunt a casual signup loop. Not a security number.
export const SIGNUP_MAX_PER_WINDOW = 20;

/** The client IP behind Cloudflare (falls back to a shared bucket if absent). */
export function clientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

/**
 * Register a signup attempt from `ip` and report whether it's allowed
 * (sliding window in the per-key DO). Returns `{ allowed, retryAfterSeconds }`.
 */
export async function checkAndBumpSignup(
  limiter: RateLimiterNamespace,
  ip: string,
  now: Date = new Date(),
): Promise<BumpOutcome> {
  try {
    return await stubFor(limiter, `signup:${ip}`).checkAndBump(SIGNUP_WINDOW_MS, SIGNUP_MAX_PER_WINDOW, now.getTime());
  } catch (err) {
    failOpen("signup", err);
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

// --- login brute-force fence ----------------------------------------------

export const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
export const LOGIN_MAX_FAILURES = 5;

/** Per-(ip, email) key so a lockout can't be weaponized to lock a victim out globally. */
export function loginKey(ip: string, email: string): string {
  return `${ip}|${email.trim().toLowerCase()}`;
}

/**
 * Is this (ip, email) currently locked out? A locked key refuses even a correct
 * password until enough failures age out of the sliding window — that's the
 * brute-force fence. Returns the retry-after so callers can surface it.
 */
export async function isLoginLocked(
  limiter: RateLimiterNamespace,
  key: string,
  now: Date = new Date(),
): Promise<LockOutcome> {
  try {
    return await stubFor(limiter, `login:${key}`).isLocked(LOGIN_WINDOW_MS, LOGIN_MAX_FAILURES, now.getTime());
  } catch (err) {
    failOpen("login-check", err);
    return { locked: false, retryAfterSeconds: 0 };
  }
}

/** Record a failed login attempt (ages out of the sliding window on its own). */
export async function recordLoginFailure(
  limiter: RateLimiterNamespace,
  key: string,
  now: Date = new Date(),
): Promise<void> {
  try {
    await stubFor(limiter, `login:${key}`).recordFailure(LOGIN_WINDOW_MS, now.getTime());
  } catch (err) {
    failOpen("login-record", err);
  }
}

/** Clear the failure counter on a successful login. */
export async function clearLoginFailures(limiter: RateLimiterNamespace, key: string): Promise<void> {
  try {
    await stubFor(limiter, `login:${key}`).clear();
  } catch (err) {
    failOpen("login-clear", err);
  }
}

// --- magic-link send fence -------------------------------------------------

export const MAGIC_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
// A handful of link requests per (ip,email) per window — room for a legit resend,
// tight enough to blunt email bombing. Not a security number (see the file header).
export const MAGIC_MAX_PER_WINDOW = 5;

/**
 * Register a magic-link send from `(ip, email)` and report whether it's allowed.
 * Keyed per (ip,email) — same shape as {@link loginKey} — so the fence is about
 * the submitter's rate, never a signal of whether the account exists.
 */
export async function checkAndBumpMagic(
  limiter: RateLimiterNamespace,
  ip: string,
  email: string,
  now: Date = new Date(),
): Promise<BumpOutcome> {
  try {
    return await stubFor(limiter, `magic:${loginKey(ip, email)}`).checkAndBump(
      MAGIC_WINDOW_MS,
      MAGIC_MAX_PER_WINDOW,
      now.getTime(),
    );
  } catch (err) {
    failOpen("magic", err);
    return { allowed: true, retryAfterSeconds: 0 };
  }
}
