/**
 * Handles core (src/handles.ts, migration 0022 — the GitHub owner-model). Two
 * layers: the PURE validation/suggestion helpers (HANDLE_RE shape, the reserved
 * list, email-derived suggestions) and the DB claim path (`claimHandle` +
 * `getOwnerHandle`/`handleIsAvailable`) exercised against the real D1 under
 * workerd — claim-once, the concurrent-claim race, and canonicalization.
 */
import { env } from "cloudflare:test";
import { afterEach, describe, expect, test } from "vitest";
import {
  HandleAlreadySetError,
  HandleInvalidError,
  HandleTakenError,
  RESERVED_HANDLES,
  claimHandle,
  getOwnerHandle,
  handleIsAvailable,
  suggestHandleFromEmail,
  validateHandle,
} from "../src/handles.ts";
import { createUser } from "../src/users.ts";

async function seedUser(email: string): Promise<string> {
  const user = await createUser(env.DB, email, "");
  return user.id;
}

afterEach(async () => {
  await env.DB.prepare("DELETE FROM owners WHERE handle LIKE 'h-%' OR handle LIKE 'race-%'").run();
  await env.DB.prepare("DELETE FROM users WHERE email LIKE 'handle-%'").run();
});

// --- validateHandle (pure) ---------------------------------------------------

describe("validateHandle — shape + reserved", () => {
  test.each([
    ["a lowercase word", "aaron", "aaron"],
    ["digits", "user123x", "user123x"], // note: bare "user123" — fine; not reserved
    ["an interior hyphen", "field-notes", "field-notes"],
    ["consecutive interior hyphens (policy fences only the ends)", "a--b", "a--b"],
    ["a 3-char minimum", "abc", "abc"],
    ["a 30-char maximum", "a".repeat(30), "a".repeat(30)],
    ["mixed case → canonical lowercase (GitHub behaviour)", "Field-Notes", "field-notes"],
    ["surrounding whitespace trimmed", "  aaron  ", "aaron"],
  ] as const)("accepts %s", (_label, raw, canonical) => {
    expect(validateHandle(raw)).toEqual({ ok: true, handle: canonical });
  });

  test.each([
    ["too short (2 chars)", "ab"],
    ["empty", ""],
    ["a leading hyphen", "-abc"],
    ["a trailing hyphen", "abc-"],
    ["too long (31 chars)", "a".repeat(31)],
    ["an underscore (outside the charset)", "a_b"],
    ["a space (outside the charset)", "a b"],
    ["uppercase that survives as non-charset", "AB"], // 2 chars → too short even lowercased
    ["a dot", "a.b"],
  ] as const)("rejects %s as invalid", (_label, raw) => {
    expect(validateHandle(raw)).toEqual({ ok: false, reason: "invalid" });
  });

  test.each([["admin"], ["api"], ["parachute"], ["well-known"], ["notes"], ["support"]] as const)(
    "rejects the reserved name %s",
    (name) => {
      expect(validateHandle(name)).toEqual({ ok: false, reason: "reserved" });
    },
  );

  test("a short reserved word (e.g. 'u', 'me') is caught by the SHAPE rule first (invalid, not reserved)", () => {
    // The reserved set is a superset that also lists <3-char platform words as
    // defense-in-depth if the shape rule ever loosens; today the RE rejects them
    // as `invalid` before the reserved check runs. Either way the claim fails.
    expect(validateHandle("u")).toEqual({ ok: false, reason: "invalid" });
    expect(validateHandle("me")).toEqual({ ok: false, reason: "invalid" });
  });

  test("a reserved name in mixed case is still refused (canonicalized first)", () => {
    expect(validateHandle("Admin")).toEqual({ ok: false, reason: "reserved" });
  });
});

// --- suggestHandleFromEmail (pure) -------------------------------------------

describe("suggestHandleFromEmail — always a valid, non-reserved handle", () => {
  test("uses the email local part when it is already a valid handle", () => {
    expect(suggestHandleFromEmail("aaron@unforced.org")).toBe("aaron");
  });

  test("strips characters outside the charset and trims hyphens", () => {
    expect(suggestHandleFromEmail("aaron.gabriel+notes@x.com")).toBe("aarongabrielnotes");
  });

  test("appends a numeric suffix when the local part is a reserved word", () => {
    const s = suggestHandleFromEmail("admin@x.com");
    expect(s).not.toBe("admin");
    expect(RESERVED_HANDLES.has(s)).toBe(false);
    expect(validateHandle(s)).toEqual({ ok: true, handle: s });
  });

  test.each([
    ["a too-short local part", "ab@x.com"],
    ["a single char", "a@x.com"],
    ["an empty local part after stripping", "...@x.com"],
    ["a would-be reserved 'user'", "user@x.com"],
  ] as const)("still returns a valid, non-reserved handle for %s", (_label, email) => {
    const s = suggestHandleFromEmail(email);
    expect(validateHandle(s)).toEqual({ ok: true, handle: s });
    expect(RESERVED_HANDLES.has(s)).toBe(false);
  });
});

// --- claimHandle + lookups (D1) ----------------------------------------------

describe("claimHandle — the claim path", () => {
  test("claims a handle: creates the owners row and points users.owner_id at it", async () => {
    const id = await seedUser("handle-claim@example.com");
    const { handle, ownerId } = await claimHandle(env.DB, id, "h-alice");
    expect(handle).toBe("h-alice");

    const owner = await env.DB.prepare("SELECT handle, kind FROM owners WHERE owner_id = ?").bind(ownerId).first<{
      handle: string;
      kind: string;
    }>();
    expect(owner).toEqual({ handle: "h-alice", kind: "user" });

    const user = await env.DB.prepare("SELECT owner_id FROM users WHERE id = ?").bind(id).first<{
      owner_id: string | null;
    }>();
    expect(user?.owner_id).toBe(ownerId);
  });

  test("canonicalizes on claim — a mixed-case/whitespace input persists lowercased", async () => {
    const id = await seedUser("handle-canon@example.com");
    const { handle } = await claimHandle(env.DB, id, "  H-Bob  ");
    expect(handle).toBe("h-bob");
    expect(await getOwnerHandle(env.DB, (await currentOwnerId(id)))).toBe("h-bob");
  });

  test("claim-once — a second claim by the same account throws HandleAlreadySetError", async () => {
    const id = await seedUser("handle-once@example.com");
    await claimHandle(env.DB, id, "h-first");
    await expect(claimHandle(env.DB, id, "h-second")).rejects.toBeInstanceOf(HandleAlreadySetError);
    // The account keeps its first handle; the second never created an owners row.
    expect(await getOwnerHandle(env.DB, await currentOwnerId(id))).toBe("h-first");
    const second = await env.DB.prepare("SELECT 1 FROM owners WHERE handle = 'h-second'").first();
    expect(second).toBeNull();
  });

  test("the race — a second account claiming a taken handle throws HandleTakenError", async () => {
    const a = await seedUser("handle-race-a@example.com");
    const b = await seedUser("handle-race-b@example.com");
    await claimHandle(env.DB, a, "race-shared");
    await expect(claimHandle(env.DB, b, "race-shared")).rejects.toBeInstanceOf(HandleTakenError);
    // B is left unclaimed — the batch rolled back atomically, no orphan pointer.
    expect(await currentOwnerId(b)).toBeNull();
  });

  test.each([
    ["a bad shape", "ab", "invalid"],
    ["a reserved word", "admin", "reserved"],
  ] as const)("refuses %s before touching the DB (HandleInvalidError %s)", async (_label, raw, reason) => {
    const id = await seedUser(`handle-bad-${reason}@example.com`);
    await expect(claimHandle(env.DB, id, raw)).rejects.toMatchObject({
      name: "HandleInvalidError",
      reason,
    });
    expect(await currentOwnerId(id)).toBeNull();
  });

  test("HandleInvalidError is the thrown type for a bad shape", async () => {
    const id = await seedUser("handle-badtype@example.com");
    await expect(claimHandle(env.DB, id, "-nope-")).rejects.toBeInstanceOf(HandleInvalidError);
  });
});

describe("handleIsAvailable / getOwnerHandle", () => {
  test("available is true before a claim, false after", async () => {
    expect(await handleIsAvailable(env.DB, "h-open")).toBe(true);
    const id = await seedUser("handle-avail@example.com");
    await claimHandle(env.DB, id, "h-open");
    expect(await handleIsAvailable(env.DB, "h-open")).toBe(false);
  });

  test("getOwnerHandle short-circuits a null ownerId to null (no query)", async () => {
    expect(await getOwnerHandle(env.DB, null)).toBeNull();
  });

  test("getOwnerHandle returns null for an owner_id with no owners row", async () => {
    expect(await getOwnerHandle(env.DB, "does-not-exist")).toBeNull();
  });
});

/** The account's current owner_id (null when unclaimed) — a small read helper. */
async function currentOwnerId(userId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT owner_id FROM users WHERE id = ?").bind(userId).first<{
    owner_id: string | null;
  }>();
  return row?.owner_id ?? null;
}
