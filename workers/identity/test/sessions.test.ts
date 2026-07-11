/**
 * Session lifetime + rolling (G3, auth redesign). Pure-logic pins: the 90-day
 * TTL, the 30-day refresh threshold, the cookie Max-Age, and when a session
 * rolls forward. The DB write (slideSession) + the end-to-end roll through
 * GET /account/session are covered in account-session.test.ts.
 */
import { describe, expect, test } from "vitest";
import {
  type Session,
  SESSION_REFRESH_THRESHOLD_MS,
  SESSION_TTL_MS,
  buildSessionCookie,
  shouldSlideSession,
} from "../src/sessions.ts";

const DAY = 24 * 60 * 60 * 1000;

describe("session lifetime + rolling (G3)", () => {
  test("TTL is 90 days, refresh threshold is 30 days", () => {
    expect(SESSION_TTL_MS).toBe(90 * DAY);
    expect(SESSION_REFRESH_THRESHOLD_MS).toBe(30 * DAY);
  });

  test("cookie Max-Age matches the 90-day TTL", () => {
    expect(buildSessionCookie("sid")).toContain(`Max-Age=${SESSION_TTL_MS / 1000}`);
    // still the safe attributes.
    expect(buildSessionCookie("sid")).toContain("HttpOnly");
    expect(buildSessionCookie("sid")).toContain("SameSite=Lax");
  });

  test("shouldSlideSession: fresh no; past the 30d threshold yes; before it no", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const session: Session = {
      id: "s",
      userId: "u",
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
    };
    expect(shouldSlideSession(session, now)).toBe(false); // just created
    expect(shouldSlideSession(session, new Date(now.getTime() + 29 * DAY))).toBe(false); // 61d left
    expect(shouldSlideSession(session, new Date(now.getTime() + 31 * DAY))).toBe(true); // 59d left → roll
  });
});
