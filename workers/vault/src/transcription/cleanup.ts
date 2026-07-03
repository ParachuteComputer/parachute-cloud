/**
 * Transcript CLEANUP pass — the follow-on to cloud voice (cloud#66) that tidies
 * a raw whisper transcript into a readable note body WITHOUT ever changing the
 * words.
 *
 * Two-part design (the ratified 2026-07-03 cleanup research):
 *   1. a small text-LLM call ({@link CLEANUP_MODEL}, temperature 0) that
 *      punctuates / capitalizes / paragraphs / strips fillers — the "clean,
 *      don't rewrite" discipline harvested from parachute-scribe's cleanup
 *      prompt;
 *   2. the deterministic {@link checkFaithful} guard, which word-diffs the
 *      cleaned output against the raw transcript and DISCARDS it if it added or
 *      changed any word. The model is not trusted; the guard is the lever.
 *
 * SOFT-FAIL everywhere: an unbound model, an LLM error, an empty response, or a
 * guard rejection all return the RAW transcript unchanged (`cleaned: false`).
 * Cleanup can only ever improve the display or no-op — it can never block a
 * transcript from landing, and it can never ship a word the speaker didn't say.
 *
 * Cost: one small text-LLM call per note (~$0.0005) — it folds into the voice
 * tier's per-note cost, so there is no separate metering (the audio-duration
 * meter, set from the whisper `duration`, is the only voice meter and is
 * untouched by cleanup).
 */

import { checkFaithful, type FaithfulnessOptions } from "./faithfulness.js";

/**
 * The cleanup model, reached through the same `[ai]` binding as whisper.
 *
 * ## Why NOT `@cf/google/gemma-3-12b-it` (the research choice)
 *
 * The 2026-07-03 cleanup research picked `@cf/google/gemma-3-12b-it`. Live
 * deploy verification (2026-07-03) found the Cloudflare account (Unforced
 * Development) is **not allowed to access that model** — a bare `ai.run` returns
 * AiError 5018 ("This account is not allowed to access this model"). With
 * gemma-12b, cleanup would soft-fail to raw on EVERY note (a safe no-op, but
 * "default ON" would clean nothing). So we default to the best instruction-tuned
 * model the account CAN access.
 *
 * ## Why `@cf/meta/llama-3.3-70b-instruct-fp8-fast`
 *
 * Live-verified against the guard on a filler-heavy sample: it removed only the
 * fillers and preserved every content word → {@link checkFaithful} ACCEPTED it
 * (the 8B llama dropped a content word "and" → correctly REJECTED → raw). The
 * `fp8-fast` variant is quantized for cost/latency; the per-note cost still
 * folds into the voice tier (whisper dominates voice cost).
 *
 * ## The model is NOT the lever
 *
 * Every model's output is gated by {@link checkFaithful}, so the choice affects
 * only how OFTEN a clean view is accepted, NEVER whether a bad one can ship.
 * Swapping back to `@cf/google/gemma-3-12b-it` once the account is granted
 * access is a one-line change here (the guard makes it inconsequential-for-safety).
 */
export const CLEANUP_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/**
 * "Clean, don't rewrite" system prompt. CRITICAL: the set of removable
 * "fillers" here must MATCH {@link import("./faithfulness").DEFAULT_FILLERS} —
 * only non-lexical disfluencies (um/uh/er/hmm/…) + immediate stutter repeats.
 * If the prompt told the model to strip discourse words like "so"/"like"/"you
 * know", the guard (which does NOT whitelist those) would reject the result and
 * cleanup would soft-fail to raw on most notes — doing nothing. Model and guard
 * must agree on what "filler" means.
 */
const SYSTEM_PROMPT = `You clean up raw voice-transcript text. Your ONLY job is light copy-editing:

- Fix punctuation, capitalization, and sentence boundaries.
- Break run-on text into readable paragraphs.
- Remove ONLY non-lexical filler SOUNDS and false starts: um, uh, uhh, er, erm, hmm, mm, mhm, ah, uh-huh. Also collapse an immediate stutter repeat (e.g. "the the" → "the").
- Keep EVERY actual word exactly as spoken — INCLUDING discourse words like "so", "like", "well", "right", "actually", "basically", "you know", "I mean". Do NOT remove them.
- Do not paraphrase, summarize, reorder, translate, or correct facts. Never add, substitute, or drop a word, name, number, or negation ("not", "no", "never", "n't"). If a passage is unclear, leave it exactly as-is.

Return ONLY the cleaned transcript text — no preamble, no commentary, no quotation marks.`;

/**
 * Narrow slice of the Workers AI binding this pass needs — a text-generation
 * `run(model, { messages, temperature, max_tokens })` returning `{ response }`.
 * Declared locally (mirroring `WorkersAiLike` in workers-ai.ts) so tests inject
 * a plain stub and the DO can pass its `env.AI` without a live model.
 */
export interface TextGeneratorLike {
  run(
    model: string,
    inputs: { messages: { role: string; content: string }[] } & Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<{ response?: unknown } & Record<string, unknown>>;
}

export interface CleanupResult {
  /** Text to show in the note body: the cleaned view if accepted, else RAW. */
  text: string;
  /** True iff a cleaned view passed the guard and is what `text` holds. */
  cleaned: boolean;
  /** Why cleanup did not apply (unbound / error / empty / guard reason). */
  reason?: string;
}

export interface CleanupOptions {
  /** Tuning for the faithfulness guard (whitelist / budget). */
  guard?: FaithfulnessOptions;
  /**
   * `max_tokens` = `ceil(estimatedInputTokens * factor)` — a STRUCTURAL cap on
   * runaway generation (a faithful cleanup is never much longer than its
   * input). Defaults to 1.2× (headroom for added punctuation).
   */
  maxTokensFactor?: number;
}

/** Rough token estimate for the `max_tokens` cap (~4 chars/token). */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Clean `raw` through the model + guard. Returns the cleaned view only when the
 * model produced output AND {@link checkFaithful} accepted it; otherwise returns
 * `raw` untouched (`cleaned: false`). Never throws — every failure path
 * soft-fails to raw.
 */
export async function cleanupTranscript(
  gen: TextGeneratorLike | undefined,
  raw: string,
  opts: CleanupOptions = {},
): Promise<CleanupResult> {
  if (!gen) return { text: raw, cleaned: false, reason: "cleanup model not bound" };
  if (raw.trim().length === 0) return { text: raw, cleaned: false, reason: "empty transcript" };

  const maxTokens = Math.max(64, Math.ceil(estimateTokens(raw) * (opts.maxTokensFactor ?? 1.2)));

  let out: { response?: unknown };
  try {
    out = await gen.run(CLEANUP_MODEL, {
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: raw },
      ],
      temperature: 0,
      max_tokens: maxTokens,
    });
  } catch (err) {
    // Soft-fail: any model/network error keeps raw. Never block the transcript.
    return {
      text: raw,
      cleaned: false,
      reason: `cleanup call failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const candidate = typeof out?.response === "string" ? out.response.trim() : "";
  if (candidate.length === 0) return { text: raw, cleaned: false, reason: "empty cleanup output" };

  const verdict = checkFaithful(raw, candidate, opts.guard);
  if (!verdict.ok) return { text: raw, cleaned: false, reason: `guard rejected: ${verdict.reason}` };

  return { text: candidate, cleaned: true };
}
