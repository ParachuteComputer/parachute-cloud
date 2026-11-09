/**
 * Abuse-fence policy + the client for {@link RateLimiterDO} (#30).
 *
 * The counters live in a Durable Object — one instance per rate key, which
 * serializes updates and implements a true SLIDING window. This file owns the
 * POLICY (the same windows/limits as the retired D1 fences — see
 * migrations/0006), the key derivation, and the availability posture of every
 * DO call. Each fence is ONE DO call that checks and records together
 * (`checkAndBump`): a parallel burst can't all read "under the limit" before
 * any of them is counted (T-419, audit L3-03 F1 — the login lockout used to be
 * a separate check call and record call, and 60 parallel wrong passwords were
 * all checked).
 *
 * Two postures when the Durable Object errors or is unreachable, each with a
 * PII-free `event=rate_limiter_unavailable` log line (the op only — keys carry
 * ip/email, never log them):
 *   - FAIL OPEN for the signup and magic-link SEND fences: availability over
 *     strictness; they are abuse fences, not security controls.
 *   - FAIL CLOSED for the sign-in GUESS fences (password, 2FA code, sign-in
 *     code): a limiter outage must not turn into unlimited guessing, so the
 *     attempt is refused with the ordinary "too many attempts" answer.
 *
 * An attacker rotating source IPs still walks around any IP-keyed limit. Real
 * bot fences (Turnstile, email verification) remain design §6 Phase 5
 * (cloud#48).
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
 * namespace — the outage tests inject one whose stub always throws).
 */
export interface RateLimiterNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): RateLimiterStub;
}
interface RateLimiterStub {
  checkAndBump(windowMs: number, max: number, nowMs: number): Promise<BumpOutcome>;
  clear(): Promise<void>;
}

function stubFor(limiter: RateLimiterNamespace, key: string): RateLimiterStub {
  return limiter.get(limiter.idFromName(key));
}

/** PII-free unavailability trail (op only — keys carry ip/email, never log them). */
function limiterDown(op: string, err: unknown): void {
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
    limiterDown("signup", err);
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

/** What a sign-in guess door answers when the limiter itself is down (fail closed). */
export const LIMITER_DOWN_RETRY_SECONDS = 60;

/**
 * Reserve one guess for this (ip, email) key BEFORE checking the secret, in a
 * single atomic DO call: `locked: false` means a slot was taken (it counts as
 * a failure until {@link clearLoginFailures} wipes the key on success);
 * `locked: true` means the window already holds the limit of guesses and
 * nothing was recorded (being blocked never extends the block). A locked key
 * refuses even a correct secret until enough guesses age out of the window.
 *
 * FAIL CLOSED: if the DO is unreachable the guess is refused (`locked: true`).
 */
export async function attemptLogin(
  limiter: RateLimiterNamespace,
  key: string,
  now: Date = new Date(),
): Promise<LockOutcome> {
  try {
    const out = await stubFor(limiter, `login:${key}`).checkAndBump(LOGIN_WINDOW_MS, LOGIN_MAX_FAILURES, now.getTime());
    return { locked: !out.allowed, retryAfterSeconds: out.retryAfterSeconds };
  } catch (err) {
    limiterDown("login-attempt", err);
    return { locked: true, retryAfterSeconds: LIMITER_DOWN_RETRY_SECONDS };
  }
}

/** Clear the failure counter on a successful login. */
export async function clearLoginFailures(limiter: RateLimiterNamespace, key: string): Promise<void> {
  try {
    await stubFor(limiter, `login:${key}`).clear();
  } catch (err) {
    limiterDown("login-clear", err);
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
    limiterDown("magic", err);
    return { allowed: true, retryAfterSeconds: 0 };
  }
}
