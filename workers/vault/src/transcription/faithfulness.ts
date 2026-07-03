/**
 * The transcript-cleanup FAITHFULNESS GUARD (cloud voice cleanup pass).
 *
 * The insight from the 2026-07-03 cleanup research: **the model is not the
 * lever — a deterministic guard is.** No prompt makes an LLM incapable of
 * hallucinating a word; a fresh model on a hard sentence still occasionally
 * rewrites "algorithms" into "I like Al Gore". So instead of trusting the
 * model, we word-diff its output against the RAW transcript and REFUSE any
 * output that adds or changes words. Worst case the user gets the raw
 * transcript back — never a borked one. Shipping altered words is made
 * STRUCTURALLY IMPOSSIBLE, not merely unlikely (the NVIDIA-Granary pattern).
 *
 * ## The formalization: cleaned must be a SUBSEQUENCE of raw
 *
 * A faithful cleanup only ever:
 *   - changes punctuation / casing / whitespace  → normalized away by
 *     {@link tokenize} (both sides reduce to the same lowercased alnum tokens);
 *   - inserts paragraph breaks                    → whitespace, normalized away;
 *   - DELETES filler words / stumbles             → removes tokens.
 *
 * None of those can ADD a token to the stream or SUBSTITUTE one token for a
 * different one. So a faithful cleaning's token stream is exactly the raw token
 * stream with some tokens deleted — i.e. **cleaned's tokens are a subsequence
 * of raw's tokens.** If they are NOT a subsequence, the cleaned text contains a
 * word that was never spoken (an insertion) or a word swapped for another (a
 * substitution) → REJECT. This zero-tolerance on added/changed words is
 * deliberately stricter than a "small substitution budget" would be: a changed
 * word is exactly the failure mode we exist to prevent.
 *
 * The only tolerated edit is DELETION, and even that is bounded:
 *   - deleting a whitelisted {@link DEFAULT_FILLERS} token is free (that IS the
 *     sanctioned cleanup — the whitelist is co-designed with the cleanup prompt
 *     so the guard permits exactly what the prompt is told to remove);
 *   - deleting any OTHER token (a real content word, a stutter-repair repeat)
 *     counts against a tiny budget (~{@link DEFAULT_MAX_CHANGE_RATIO} of the raw
 *     word count). Over budget → REJECT (too much removed to trust).
 *
 * Note the asymmetry that makes this safe: a deletion can only ever DROP
 * something the speaker said — it can never FABRICATE content. The catastrophic
 * failure (an invented/changed word) is always an insertion or a substitution,
 * and both are hard-rejected by the subsequence test regardless of the budget.
 *
 * O(n) time, O(1) extra space (a two-pointer subsequence walk) — no LCS/DP
 * table, so it stays cheap even for a long transcript inside the 128 MB DO.
 */

/** Default per-word budget for NON-filler deletions (~2% of the raw words). */
export const DEFAULT_MAX_CHANGE_RATIO = 0.02;

/**
 * Filler / discourse tokens whose DELETION is sanctioned cleanup. Co-designed
 * with the cleanup prompt (`cleanup.ts` SYSTEM_PROMPT) — it must be a superset
 * of what the prompt is instructed to strip, so a faithful cleaning never trips
 * the budget just for doing its job. INSERTING or SUBSTITUTING any of these is
 * still rejected (that's an added/changed word); only their removal is free.
 *
 * Bare pronouns "i"/"you" and the discourse markers "so"/"like"/"right"/"well"
 * are included because the prompt removes "you know" / "I mean" / leading "so"
 * — the deletion-only safety property means the worst case is slightly-eager
 * filler removal (the speaker's own words dropped), never a fabricated word.
 */
export const DEFAULT_FILLERS: ReadonlySet<string> = new Set([
  // non-lexical hesitations
  "um", "umm", "ummm", "uh", "uhh", "uhm", "er", "err", "erm", "ah", "ahh",
  "eh", "oh", "hmm", "hm", "mm", "mmm", "mhm", "mmhmm", "uhhuh",
  // discourse fillers the prompt strips
  "like", "so", "basically", "actually", "literally", "right", "well",
  "anyway", "anyways", "okay", "ok", "yknow",
  // components of "you know" / "I mean"
  "you", "know", "i", "mean",
]);

export interface FaithfulnessOptions {
  /** Override the sanctioned-deletion whitelist (defaults to {@link DEFAULT_FILLERS}). */
  fillers?: ReadonlySet<string>;
  /** Override the non-filler deletion budget ratio (defaults to {@link DEFAULT_MAX_CHANGE_RATIO}). */
  maxChangeRatio?: number;
}

export interface FaithfulnessResult {
  /** True = the cleaned text is a faithful view of raw and safe to show. */
  ok: boolean;
  /** Machine/human reason when `ok` is false. */
  reason?: string;
  /** Count of non-filler raw tokens the cleaned text dropped. */
  nonFillerDeletions: number;
  /** The budget that count was checked against (`floor(rawWords * ratio)`). */
  budget: number;
}

/**
 * Normalize text into comparable word tokens: lowercase, drop apostrophes (so
 * `don't` == `dont`), and split on everything that isn't a Unicode letter or
 * number (whitespace, punctuation, hyphens, newlines all separate). Casing,
 * punctuation and paragraph breaks therefore never register as a difference —
 * only the actual word stream does.
 */
export function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[’ʼ'`]/g, "").match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Decide whether `cleaned` is a faithful cleanup of `raw`. See the module doc
 * for the full contract. Returns `{ ok: false }` for any added/changed word or
 * for over-budget non-filler deletion; `{ ok: true }` for a pure
 * punctuation/casing/paragraph/whitelisted-filler cleanup.
 */
export function checkFaithful(
  raw: string,
  cleaned: string,
  opts: FaithfulnessOptions = {},
): FaithfulnessResult {
  const fillers = opts.fillers ?? DEFAULT_FILLERS;
  const ratio = opts.maxChangeRatio ?? DEFAULT_MAX_CHANGE_RATIO;

  const R = tokenize(raw);
  const C = tokenize(cleaned);
  const budget = Math.floor(R.length * ratio);

  // Both empty → trivially faithful (nothing to show either way).
  if (R.length === 0 && C.length === 0) return { ok: true, nonFillerDeletions: 0, budget: 0 };

  // Non-empty raw wiped to empty → refuse (a cleaning that erases the whole
  // transcript is never faithful; keep the raw).
  if (C.length === 0) {
    return { ok: false, reason: "cleaned transcript is empty", nonFillerDeletions: R.length, budget };
  }

  // Subsequence walk: every cleaned token must appear, in order, in raw. A
  // cleaned token that can't be matched = an inserted or substituted word.
  let i = 0; // index into R (raw tokens)
  let j = 0; // index into C (cleaned tokens)
  let nonFillerDeletions = 0;
  while (i < R.length && j < C.length) {
    if (R[i] === C[j]) {
      i++;
      j++;
    } else {
      // R[i] is deleted (skipped) — classify it.
      if (!fillers.has(R[i]!)) nonFillerDeletions++;
      i++;
    }
  }

  if (j < C.length) {
    // Leftover cleaned tokens with no matching raw token = added/changed words.
    return {
      ok: false,
      reason: `cleaned text adds or changes words (unmatched "${C[j]}")`,
      nonFillerDeletions,
      budget,
    };
  }

  // Any trailing raw tokens are deletions too.
  while (i < R.length) {
    if (!fillers.has(R[i]!)) nonFillerDeletions++;
    i++;
  }

  if (nonFillerDeletions > budget) {
    return {
      ok: false,
      reason: `removed ${nonFillerDeletions} non-filler word(s), over the budget of ${budget}`,
      nonFillerDeletions,
      budget,
    };
  }

  return { ok: true, nonFillerDeletions, budget };
}
