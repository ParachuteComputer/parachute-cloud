/**
 * The transcript-cleanup FAITHFULNESS GUARD (cloud voice cleanup pass).
 *
 * Pins the load-bearing safety properties: a cleaned transcript is accepted
 * ONLY when it (1) adds/changes NO word (subsequence rule), (2) drops NO
 * negation (meaning-flip rule), and (3) drops non-filler words only within a
 * tiny capped budget. The whitelist is narrow — true disfluencies only. Pure
 * logic, no DO/AI binding.
 */
import { describe, expect, it } from "vitest";
import {
  checkFaithful,
  tokenize,
  DEFAULT_MAX_CHANGE_RATIO,
  DEFAULT_ABSOLUTE_DELETION_CAP,
} from "../src/transcription/faithfulness.ts";

describe("tokenize", () => {
  it("lowercases, drops apostrophes, splits on punctuation/whitespace/hyphens", () => {
    expect(tokenize("Hello, WORLD!")).toEqual(["hello", "world"]);
    expect(tokenize("don't")).toEqual(["dont"]);
    expect(tokenize("don’t")).toEqual(["dont"]); // curly apostrophe too
    expect(tokenize("well-being")).toEqual(["well", "being"]);
    expect(tokenize("  spaced\n\nout  ")).toEqual(["spaced", "out"]);
    expect(tokenize("")).toEqual([]);
  });
});

describe("checkFaithful — added/changed words (fabrication)", () => {
  it("REJECTS a hallucinated insertion (algorithms → I like Al Gore) → keep raw", () => {
    const v = checkFaithful("my favorite topic is algorithms", "my favorite topic is I like Al Gore");
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/adds or changes words/);
  });

  it("REJECTS a substitution (cat → car) — a changed word is never faithful", () => {
    const v = checkFaithful("the cat sat on the mat", "the car sat on the mat");
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/car/);
  });

  it("REJECTS an appended sentence (pure insertion)", () => {
    expect(checkFaithful("hello world", "hello world and then I went home").ok).toBe(false);
  });

  it("REJECTS an INSERTED filler too (only DELETING a filler is free)", () => {
    expect(checkFaithful("I went home", "um I went home").ok).toBe(false);
  });
});

describe("checkFaithful — negation is sacred (meaning-flip fix)", () => {
  it("REJECTS a dropped negation ('I will not go' → 'I will go')", () => {
    const v = checkFaithful("I will not go", "I will go");
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/negation/);
  });

  it("REJECTS a dropped contraction negation ('I can't go there' → 'I can go there')", () => {
    const v = checkFaithful("I can't go there", "I can go there");
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/negation/);
  });

  it("REJECTS a dropped 'not' on a LONG transcript even though the budget would allow one drop", () => {
    // 200 words, one is "not"; budget = min(floor(200*0.02)=4, cap 3) = 3, so a
    // lone drop would normally fit — but negators are never budget-eligible.
    const words = Array.from({ length: 200 }, (_, k) => (k === 100 ? "not" : `w${k}`));
    const raw = words.join(" ");
    const cleaned = words.filter((_, k) => k !== 100).join(" ");
    const v = checkFaithful(raw, cleaned);
    expect(v.budget).toBe(3);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/negation/);
  });
});

describe("checkFaithful — narrow disfluency whitelist", () => {
  it("ACCEPTS disfluency deletions (um/uh/er/hmm) with zero non-filler drops", () => {
    const v = checkFaithful("um I went to the store uh er and hmm bought milk", "I went to the store and bought milk");
    expect(v.ok).toBe(true);
    expect(v.nonFillerDeletions).toBe(0);
  });

  it("REJECTS dropping a content word now that 'like' is NOT a filler ('I really like turtles' → 'I really turtles')", () => {
    const v = checkFaithful("I really like turtles", "I really turtles");
    expect(v.ok).toBe(false); // "like" is a non-filler deletion; budget 0 on a 4-word note
  });

  it("'so' is NOT a filler — dropping it counts against budget (rejected on a short note)", () => {
    expect(checkFaithful("so I went home", "I went home").ok).toBe(false);
  });

  it("ACCEPTS punctuation + casing + paragraph when every word is KEPT (including 'so')", () => {
    const raw = "so hello world this is a test we can see if it works";
    const cleaned = "So, hello world. This is a test.\n\nWe can see if it works.";
    expect(checkFaithful(raw, cleaned).ok).toBe(true);
  });
});

describe("checkFaithful — budget + cap", () => {
  it("budget boundary: non-filler deletions accepted at the budget, rejected one over", () => {
    // 100 distinct non-filler words → budget = min(floor(100*0.02)=2, cap 3) = 2.
    const words = Array.from({ length: 100 }, (_, k) => `word${k}`);
    const raw = words.join(" ");
    expect(DEFAULT_MAX_CHANGE_RATIO).toBe(0.02);

    const drop2 = words.filter((_, k) => k !== 10 && k !== 20).join(" ");
    const at = checkFaithful(raw, drop2);
    expect(at.budget).toBe(2);
    expect(at.nonFillerDeletions).toBe(2);
    expect(at.ok).toBe(true);

    const drop3 = words.filter((_, k) => k !== 10 && k !== 20 && k !== 30).join(" ");
    const over = checkFaithful(raw, drop3);
    expect(over.nonFillerDeletions).toBe(3);
    expect(over.ok).toBe(false);
    expect(over.reason).toMatch(/over the budget/);
  });

  it("the ABSOLUTE CAP holds the budget down on a long transcript (10% ratio would allow 10, cap = 3)", () => {
    const words = Array.from({ length: 505 }, (_, k) => `w${k}`);
    const raw = words.join(" ");
    const drop3 = words.filter((_, k) => ![10, 20, 30].includes(k)).join(" ");
    const at = checkFaithful(raw, drop3);
    expect(at.budget).toBe(DEFAULT_ABSOLUTE_DELETION_CAP); // 3, NOT floor(505*0.02)=10
    expect(at.ok).toBe(true);

    const drop4 = words.filter((_, k) => ![10, 20, 30, 40].includes(k)).join(" ");
    const over = checkFaithful(raw, drop4);
    expect(over.nonFillerDeletions).toBe(4);
    expect(over.ok).toBe(false);
  });

  it("ACCEPTS a legit long cleanup: disfluency removal + punctuation/casing/paragraph + one stutter-dedup within the cap", () => {
    const words = Array.from({ length: 60 }, (_, k) => `w${k}`);
    // raw: leading "um", a "w10 w10" stutter, trailing "uh".
    const raw = ["um", ...words.slice(0, 11), "w10", ...words.slice(11), "uh"].join(" ");
    // cleaned: um/uh removed, the w10 stutter collapsed, punctuation + a paragraph break added.
    const cleaned = words.slice(0, 30).join(" ") + ".\n\n" + words.slice(30).join(" ") + ".";
    const v = checkFaithful(raw, cleaned);
    expect(v.nonFillerDeletions).toBe(1); // just the stutter
    expect(v.budget).toBeGreaterThanOrEqual(1);
    expect(v.ok).toBe(true);
  });

  it("options: a looser ratio + higher cap widen the budget", () => {
    const words = Array.from({ length: 20 }, (_, k) => `w${k}`);
    const raw = words.join(" ");
    const drop3 = words.filter((_, k) => k > 2).join(" "); // drop 3 leading words
    expect(checkFaithful(raw, drop3).ok).toBe(false); // default budget 0
    expect(checkFaithful(raw, drop3, { maxChangeRatio: 0.2, maxDeletions: 5 }).ok).toBe(true); // min(4,5)=4 ≥ 3
  });
});

describe("checkFaithful — edges", () => {
  it("REJECTS wiping a non-empty transcript to empty (never erase the capture)", () => {
    const v = checkFaithful("hello world this matters", "   ");
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/empty/);
  });

  it("ACCEPTS the empty/empty case (nothing to change)", () => {
    expect(checkFaithful("", "").ok).toBe(true);
  });

  it("ACCEPTS an identical transcript (a no-op cleanup)", () => {
    const t = "The quick brown fox jumps over the lazy dog.";
    expect(checkFaithful(t, t).ok).toBe(true);
  });
});
