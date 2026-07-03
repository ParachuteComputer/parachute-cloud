/**
 * The transcript-cleanup FAITHFULNESS GUARD (cloud voice cleanup pass).
 *
 * These pin the load-bearing safety property: a cleaned transcript is accepted
 * ONLY when it is a punctuation/casing/paragraph/whitelisted-filler view of the
 * raw — any added or changed word is rejected so the note can never show a word
 * the speaker didn't say. Pure logic, no DO/AI binding.
 */
import { describe, expect, it } from "vitest";
import {
  checkFaithful,
  tokenize,
  DEFAULT_MAX_CHANGE_RATIO,
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

describe("checkFaithful — the guard", () => {
  it("REJECTS a hallucinated insertion (algorithms → I like Al Gore) → keep raw", () => {
    const raw = "my favorite topic is algorithms";
    const cleaned = "my favorite topic is I like Al Gore";
    const v = checkFaithful(raw, cleaned);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/adds or changes words/);
  });

  it("ACCEPTS a legit punctuation + casing + paragraph cleanup (words unchanged)", () => {
    const raw = "hello world this is a test so we can see if it works";
    const cleaned = "Hello world. This is a test.\n\nWe can see if it works."; // "so" filler dropped
    expect(checkFaithful(raw, cleaned).ok).toBe(true);
  });

  it("ACCEPTS whitelisted-filler deletions (um/uh/so/you know) with zero non-filler drops", () => {
    const raw = "um so I went to the store uh you know";
    const cleaned = "I went to the store";
    const v = checkFaithful(raw, cleaned);
    expect(v.ok).toBe(true);
    expect(v.nonFillerDeletions).toBe(0);
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
    // "um" prepended is an addition, not a removal → not a subsequence → reject.
    expect(checkFaithful("I went home", "um I went home").ok).toBe(false);
  });

  it("budget boundary: non-filler deletions accepted at the budget, rejected one over", () => {
    // 100 distinct non-filler words → budget = floor(100 * 0.02) = 2.
    const words = Array.from({ length: 100 }, (_, k) => `word${k}`);
    const raw = words.join(" ");
    expect(DEFAULT_MAX_CHANGE_RATIO).toBe(0.02);

    // Remove exactly 2 (at budget) → ACCEPT.
    const drop2 = words.filter((_, k) => k !== 10 && k !== 20).join(" ");
    const at = checkFaithful(raw, drop2);
    expect(at.budget).toBe(2);
    expect(at.nonFillerDeletions).toBe(2);
    expect(at.ok).toBe(true);

    // Remove 3 (one over) → REJECT.
    const drop3 = words.filter((_, k) => k !== 10 && k !== 20 && k !== 30).join(" ");
    const over = checkFaithful(raw, drop3);
    expect(over.nonFillerDeletions).toBe(3);
    expect(over.ok).toBe(false);
    expect(over.reason).toMatch(/over the budget/);
  });

  it("a custom (looser) ratio widens the non-filler deletion budget", () => {
    const words = Array.from({ length: 20 }, (_, k) => `w${k}`);
    const raw = words.join(" ");
    const drop3 = words.filter((_, k) => k > 2).join(" "); // drop 3 leading words
    // Default 2% of 20 = budget 0 → reject.
    expect(checkFaithful(raw, drop3).ok).toBe(false);
    // 20% → budget 4 → accept.
    expect(checkFaithful(raw, drop3, { maxChangeRatio: 0.2 }).ok).toBe(true);
  });

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
