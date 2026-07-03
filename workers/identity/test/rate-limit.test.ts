/**
 * RateLimiterDO + fail-open client tests (#30). The DO runs for real inside
 * workerd (env.RATE_LIMITER from wrangler.toml); its storage participates in
 * vitest-pool-workers isolated storage, so each test sees fresh counters.
 *
 * Covered: sliding-window behavior (including the end-of-window burst the old
 * fixed-window D1 fence allowed), per-key isolation, lockout record/clear
 * semantics, and the FAIL-OPEN posture when the DO is unreachable.
 */
import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import {
  LOGIN_MAX_FAILURES,
  LOGIN_WINDOW_MS,
  MAGIC_MAX_PER_WINDOW,
  SIGNUP_MAX_PER_WINDOW,
  SIGNUP_WINDOW_MS,
  checkAndBumpMagic,
  checkAndBumpSignup,
  clearLoginFailures,
  isLoginLocked,
  loginKey,
  recordLoginFailure,
  type RateLimiterNamespace,
} from "../src/rate-limit.ts";

const T0 = new Date("2026-07-02T10:00:00Z");
const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs);
const MIN = 60 * 1000;

describe("sliding window (signup fence)", () => {
  test("allows the max, then blocks with a positive retry-after", async () => {
    const ip = "198.51.100.77";
    for (let i = 0; i < SIGNUP_MAX_PER_WINDOW; i++) {
      expect((await checkAndBumpSignup(env.RATE_LIMITER, ip, at(0))).allowed).toBe(true);
    }
    const blocked = await checkAndBumpSignup(env.RATE_LIMITER, ip, at(0));
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(SIGNUP_WINDOW_MS / 1000);
  });

  test("the window SLIDES: an end-of-window burst still counts into the next hour (the fixed-window bypass is closed)", async () => {
    const ip = "198.51.100.78";
    // 1 event opens the (old, fixed) window at t0; a burst of max−1 lands at 59min.
    expect((await checkAndBumpSignup(env.RATE_LIMITER, ip, at(0))).allowed).toBe(true);
    for (let i = 0; i < SIGNUP_MAX_PER_WINDOW - 1; i++) {
      expect((await checkAndBumpSignup(env.RATE_LIMITER, ip, at(59 * MIN))).allowed).toBe(true);
    }
    // t0+61min: the OLD fixed window would have rolled (fresh count → a whole
    // new burst allowed). Sliding: only the t0 event has aged out, the 59min
    // burst is still live — exactly ONE slot is free.
    expect((await checkAndBumpSignup(env.RATE_LIMITER, ip, at(61 * MIN))).allowed).toBe(true);
    const blocked = await checkAndBumpSignup(env.RATE_LIMITER, ip, at(61 * MIN));
    expect(blocked.allowed).toBe(false);
    // After the burst itself ages out, requests flow again.
    expect((await checkAndBumpSignup(env.RATE_LIMITER, ip, at(59 * MIN + SIGNUP_WINDOW_MS + 1000))).allowed).toBe(true);
  });

  test("a denied attempt records nothing (being blocked never extends the block)", async () => {
    const ip = "198.51.100.79";
    for (let i = 0; i < SIGNUP_MAX_PER_WINDOW; i++) await checkAndBumpSignup(env.RATE_LIMITER, ip, at(0));
    // Hammer while blocked — these must NOT push the lift time out.
    for (let i = 0; i < 10; i++) {
      expect((await checkAndBumpSignup(env.RATE_LIMITER, ip, at(30 * MIN))).allowed).toBe(false);
    }
    expect((await checkAndBumpSignup(env.RATE_LIMITER, ip, at(SIGNUP_WINDOW_MS + 1000))).allowed).toBe(true);
  });

  test("per-key isolation: one saturated IP never affects another", async () => {
    for (let i = 0; i <= SIGNUP_MAX_PER_WINDOW; i++) await checkAndBumpSignup(env.RATE_LIMITER, "203.0.113.1", at(0));
    expect((await checkAndBumpSignup(env.RATE_LIMITER, "203.0.113.1", at(0))).allowed).toBe(false);
    expect((await checkAndBumpSignup(env.RATE_LIMITER, "203.0.113.2", at(0))).allowed).toBe(true);
  });
});

describe("login lockout (record / check / clear)", () => {
  const key = loginKey("203.0.113.9", "Locked@Example.com");

  test("locks after max failures, reports retry-after, unlocks when failures age out", async () => {
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) {
      expect((await isLoginLocked(env.RATE_LIMITER, key, at(0))).locked).toBe(false);
      await recordLoginFailure(env.RATE_LIMITER, key, at(0));
    }
    const locked = await isLoginLocked(env.RATE_LIMITER, key, at(0));
    expect(locked.locked).toBe(true);
    expect(locked.retryAfterSeconds).toBeGreaterThan(0);
    expect(locked.retryAfterSeconds).toBeLessThanOrEqual(LOGIN_WINDOW_MS / 1000);
    // The sliding window frees the key once the failures age out.
    expect((await isLoginLocked(env.RATE_LIMITER, key, at(LOGIN_WINDOW_MS + 1000))).locked).toBe(false);
  });

  test("a successful login clears the counter atomically", async () => {
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) await recordLoginFailure(env.RATE_LIMITER, key, at(0));
    expect((await isLoginLocked(env.RATE_LIMITER, key, at(0))).locked).toBe(true);
    await clearLoginFailures(env.RATE_LIMITER, key);
    expect((await isLoginLocked(env.RATE_LIMITER, key, at(0))).locked).toBe(false);
  });

  test("per-key isolation: same email from another IP is unaffected", async () => {
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) await recordLoginFailure(env.RATE_LIMITER, key, at(0));
    const otherIp = loginKey("203.0.113.10", "locked@example.com");
    expect((await isLoginLocked(env.RATE_LIMITER, key, at(0))).locked).toBe(true);
    expect((await isLoginLocked(env.RATE_LIMITER, otherIp, at(0))).locked).toBe(false);
  });
});

describe("magic-link fence", () => {
  test("allows the max per (ip,email), then blocks; another email on the same IP is unaffected", async () => {
    for (let i = 0; i < MAGIC_MAX_PER_WINDOW; i++) {
      expect((await checkAndBumpMagic(env.RATE_LIMITER, "9.9.9.9", "flood@example.com", at(0))).allowed).toBe(true);
    }
    expect((await checkAndBumpMagic(env.RATE_LIMITER, "9.9.9.9", "flood@example.com", at(0))).allowed).toBe(false);
    expect((await checkAndBumpMagic(env.RATE_LIMITER, "9.9.9.9", "other@example.com", at(0))).allowed).toBe(true);
  });
});

describe("fail-open posture (DO unreachable)", () => {
  const brokenLimiter: RateLimiterNamespace = {
    idFromName: (name: string) => ({ toString: () => name }) as unknown as DurableObjectId,
    get: () => {
      throw new Error("simulated DO outage");
    },
  };

  test("checkAndBumpSignup allows when the DO errors", async () => {
    expect(await checkAndBumpSignup(brokenLimiter, "10.0.0.1")).toEqual({ allowed: true, retryAfterSeconds: 0 });
  });

  test("checkAndBumpMagic allows when the DO errors", async () => {
    expect(await checkAndBumpMagic(brokenLimiter, "10.0.0.1", "a@example.com")).toEqual({
      allowed: true,
      retryAfterSeconds: 0,
    });
  });

  test("isLoginLocked reports unlocked when the DO errors", async () => {
    expect(await isLoginLocked(brokenLimiter, loginKey("10.0.0.1", "a@example.com"))).toEqual({
      locked: false,
      retryAfterSeconds: 0,
    });
  });

  test("recordLoginFailure/clearLoginFailures swallow DO errors (login flow never 500s on the fence)", async () => {
    await expect(recordLoginFailure(brokenLimiter, "k")).resolves.toBeUndefined();
    await expect(clearLoginFailures(brokenLimiter, "k")).resolves.toBeUndefined();
  });
});
