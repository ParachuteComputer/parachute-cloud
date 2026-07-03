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
 *   - DELETES filler sounds / stutter repeats     → removes tokens.
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
 * ## Deletions are bounded (the meaning-change fix)
 *
 * Fabrication is already impossible (a deletion can only DROP what the speaker
 * said, never invent). But a deletion can still change MEANING — most sharply
 * by dropping a NEGATION. So deleted raw tokens are governed by three rules, in
 * order:
 *
 *   1. **Negators are sacred.** Deleting ANY token in {@link NEGATORS} (not, no,
 *      never, can't/cannot, without, neither, …) → AUTO-REJECT, regardless of
 *      budget. A dropped "not" flips the meaning of the sentence and must never
 *      pass.
 *   2. **True disfluencies are free.** Deleting a token in {@link DEFAULT_FILLERS}
 *      (um, uh, er, hmm, …) is the sanctioned cleanup — co-designed with the
 *      cleanup prompt, which is told to remove exactly these. The whitelist is
 *      intentionally NARROW: only non-lexical hesitation sounds, NOT content
 *      words like "so"/"like"/"right"/"well" (those carry meaning — "turn
 *      right", "I like turtles" — and are kept as spoken).
 *   3. **Everything else is budgeted.** Any other deletion (a content word, a
 *      stutter-repair repeat) counts against a tiny budget:
 *      `min(floor(rawWords × {@link DEFAULT_MAX_CHANGE_RATIO}),
 *      {@link DEFAULT_ABSOLUTE_DELETION_CAP})`. The absolute cap stops the
 *      percentage budget from accumulating into a large delete-licence on a
 *      long transcript. Over budget → REJECT.
 *
 * ## Known limitation (documented, accepted)
 *
 * A NON-negation content word may still be dropped WITHIN the tiny cap (e.g.
 * one stutter-repair, or a single dropped word on a long note). That residual
 * is bounded (≤ {@link DEFAULT_ABSOLUTE_DELETION_CAP}), non-fabricating, and
 * non-negating — the accepted cost of allowing legit stutter cleanup. The two
 * catastrophic modes — fabricating/changing a word, and flipping meaning by
 * dropping a negation — are both FULLY blocked.
 *
 * O(n) time, O(1) extra space (a two-pointer subsequence walk) — no LCS/DP
 * table, so it stays cheap even for a long transcript inside the 128 MB DO.
 */

/** Default per-word budget ratio for NON-filler deletions (~2% of raw words). */
export const DEFAULT_MAX_CHANGE_RATIO = 0.02;

/**
 * Hard ceiling on NON-filler deletions, whatever the percentage budget works
 * out to. Keeps the ~2% ratio from becoming a large delete-licence on a long
 * transcript (a 500-word note would otherwise permit ~10 content-word drops).
 * 3 is enough for a handful of stutter-repairs; more looks like rewriting.
 */
export const DEFAULT_ABSOLUTE_DELETION_CAP = 3;

/**
 * Non-lexical DISFLUENCIES whose deletion is sanctioned cleanup. Deliberately
 * NARROW — only hesitation sounds and backchannels, NOT content/discourse words
 * ("so", "like", "right", "well", "actually", "basically" all carry meaning:
 * "turn right", "I like turtles"). Co-designed with the cleanup prompt, which
 * is instructed to remove exactly these (and nothing else). INSERTING or
 * SUBSTITUTING any of these is still rejected (that's an added/changed word);
 * only their removal is free.
 */
export const DEFAULT_FILLERS: ReadonlySet<string> = new Set([
  "um", "umm", "ummm", "uh", "uhh", "uhm", "er", "err", "erm",
  "ah", "ahh", "hmm", "hm", "mm", "mmm", "mhm", "mmhmm", "uhhuh", "huh",
]);

/**
 * NEGATION tokens whose deletion is a meaning FLIP — never budget-eligible,
 * always an auto-reject. Stored NORMALIZED (lowercased, apostrophes stripped),
 * so contractions appear as `dont`/`cant`/`wont`/… (the `n't` family — the
 * tokenizer drops the apostrophe). Over-inclusion is safe: a false reject just
 * keeps the raw transcript.
 */
export const NEGATORS: ReadonlySet<string> = new Set([
  // standalone
  "not", "no", "never", "cannot", "nor", "neither", "none", "nobody",
  "nothing", "nowhere", "without", "hardly", "barely", "scarcely",
  // n't contractions (apostrophe already stripped by tokenize)
  "nt", "dont", "doesnt", "didnt", "cant", "couldnt", "wont", "wouldnt",
  "shouldnt", "isnt", "arent", "wasnt", "werent", "hasnt", "havent",
  "hadnt", "mustnt", "neednt", "shant", "aint", "mightnt", "oughtnt", "maynt",
]);

export interface FaithfulnessOptions {
  /** Override the sanctioned-deletion (disfluency) whitelist. */
  fillers?: ReadonlySet<string>;
  /** Override the negation set whose deletion auto-rejects. */
  negators?: ReadonlySet<string>;
  /** Override the non-filler deletion budget ratio (default {@link DEFAULT_MAX_CHANGE_RATIO}). */
  maxChangeRatio?: number;
  /** Override the absolute non-filler deletion cap (default {@link DEFAULT_ABSOLUTE_DELETION_CAP}). */
  maxDeletions?: number;
}

export interface FaithfulnessResult {
  /** True = the cleaned text is a faithful view of raw and safe to show. */
  ok: boolean;
  /** Machine/human reason when `ok` is false. */
  reason?: string;
  /** Count of non-filler raw tokens the cleaned text dropped. */
  nonFillerDeletions: number;
  /** The effective budget (`min(floor(rawWords × ratio), cap)`). */
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
 * for the full contract. Returns `{ ok: false }` for any added/changed word,
 * any deleted NEGATION, or over-budget non-filler deletion; `{ ok: true }` for
 * a punctuation/casing/paragraph/disfluency cleanup within the tiny budget.
 */
export function checkFaithful(
  raw: string,
  cleaned: string,
  opts: FaithfulnessOptions = {},
): FaithfulnessResult {
  const fillers = opts.fillers ?? DEFAULT_FILLERS;
  const negators = opts.negators ?? NEGATORS;
  const ratio = opts.maxChangeRatio ?? DEFAULT_MAX_CHANGE_RATIO;
  const cap = opts.maxDeletions ?? DEFAULT_ABSOLUTE_DELETION_CAP;

  const R = tokenize(raw);
  const C = tokenize(cleaned);
  const budget = Math.min(Math.floor(R.length * ratio), cap);

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

  // Classify one deleted (skipped) raw token; returns an auto-reject reason
  // string, or null to continue. Negators are sacred (rule 1); disfluencies are
  // free (rule 2); everything else is budgeted (rule 3, counted here).
  const onDelete = (tok: string): string | null => {
    if (negators.has(tok)) return `cleaned drops a negation ("${tok}") — a meaning change`;
    if (!fillers.has(tok)) nonFillerDeletions++;
    return null;
  };

  while (i < R.length && j < C.length) {
    if (R[i] === C[j]) {
      i++;
      j++;
    } else {
      const rej = onDelete(R[i]!);
      if (rej) return { ok: false, reason: rej, nonFillerDeletions, budget };
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
    const rej = onDelete(R[i]!);
    if (rej) return { ok: false, reason: rej, nonFillerDeletions, budget };
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
