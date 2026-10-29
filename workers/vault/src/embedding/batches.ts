/**
 * Sizing the embedding drain's provider calls (T-318).
 *
 * bge-m3 on Workers AI rejects a call whose texts add up to more than its
 * context window ("input exceeded the model context window (64,833 > 60,000
 * tokens)"). The drain used to slice only by COUNT (90 texts per call): 90
 * chunks of ~1,800 characters can pass 60,000 tokens, the call failed, and
 * because the next wake re-plans the same stale chunks, the alarm retried the
 * same oversized call every few seconds, forever. And core's chunker leaves an
 * unsplittable paragraph (one long line, a pasted blob) as ONE chunk of any
 * size.
 *
 * Three caps, from cheapest to last resort:
 *   1. each text is cut at {@link EMBED_MAX_CHARS_PER_TEXT} before it is sent
 *      (the vector stands for the chunk's opening; the stored content hash is
 *      still the whole chunk's, so the chunk counts as fresh and is not
 *      re-sent);
 *   2. calls are planned by total characters as well as count
 *      ({@link planEmbedBatches});
 *   3. a call the model still rejects as too long is split in half, down to
 *      one text, and a single text is halved again ({@link embedSplitting});
 *      a short text it still rejects is stored as a fixed fallback, so no
 *      chunk can make the drain retry forever.
 *
 * Characters stand in for tokens: one token per character is the worst case
 * this assumes, so a planned call never exceeds the window. Typical text runs
 * 2-4 characters per token.
 */
import type { EmbeddingProvider } from "@openparachute/core/src/embedding/provider.js";

/** Longest text handed to the model, in characters (bge-m3 reads 8,192 tokens per input). */
export const EMBED_MAX_CHARS_PER_TEXT = 8_000;

/** Total characters per provider call, kept under the 60,000-token window at one token per character. */
export const EMBED_MAX_CHARS_PER_CALL = 40_000;

/** A single text is never halved below this; a rejection there is not about length. */
export const EMBED_MIN_CHARS = 500;

/** Cut `text` to at most `max` UTF-16 units without leaving half a surrogate pair. */
export function capEmbedText(text: string, max = EMBED_MAX_CHARS_PER_TEXT): string {
  if (text.length <= max) return text;
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return text.slice(0, end);
}

/**
 * Group text indexes into calls of at most `maxTexts` texts and `maxChars`
 * characters in total (each text counted after {@link capEmbedText}). Order is
 * kept. A text alone over `maxChars` (impossible with the defaults) still gets
 * its own call.
 */
export function planEmbedBatches(
  texts: string[],
  maxTexts: number,
  maxChars = EMBED_MAX_CHARS_PER_CALL,
): number[][] {
  const batches: number[][] = [];
  let cur: number[] = [];
  let chars = 0;
  texts.forEach((text, i) => {
    const len = Math.min(text.length, EMBED_MAX_CHARS_PER_TEXT);
    if (cur.length > 0 && (cur.length >= maxTexts || chars + len > maxChars)) {
      batches.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(i);
    chars += len;
  });
  if (cur.length > 0) batches.push(cur);
  return batches;
}

/** The provider said the input is too long (Workers AI: a non-retriable `input_rejected`). */
function isInputRejected(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const err = e as Error & { code?: string; retriable?: boolean };
  return err.code === "input_rejected" && err.retriable === false;
}

/** What a chunk the model refuses outright is embedded as, so it stops coming back (see embedSplitting). */
export const EMBED_FALLBACK_TEXT = "[a passage the embedding model could not read]";

/**
 * Embed `texts`, splitting a call the model rejects as too long: halves for
 * several texts, a halved text for one. Returns one vector per text, in
 * order; a half that succeeded is kept even when its sibling is split
 * further. A single text the model still rejects at {@link EMBED_MIN_CHARS}
 * (so not about length: an odd character, a policy refusal) is embedded as
 * {@link EMBED_FALLBACK_TEXT} instead. Its stored hash is still the chunk's,
 * so it reads as fresh and no longer wedges the drain on every wake; it is
 * findable by nothing in particular. Other errors (transient, network)
 * propagate, and the caller leaves the chunks stale for the next wake.
 */
export async function embedSplitting(provider: EmbeddingProvider, texts: string[]): Promise<Float32Array[]> {
  try {
    return (await provider.embed({ texts })).vectors;
  } catch (e) {
    if (!isInputRejected(e)) throw e;
    if (texts.length > 1) {
      const mid = Math.ceil(texts.length / 2);
      const left = await embedSplitting(provider, texts.slice(0, mid));
      const right = await embedSplitting(provider, texts.slice(mid));
      return [...left, ...right];
    }
    const only = texts[0]!;
    if (only === EMBED_FALLBACK_TEXT) throw e;
    if (only.length <= EMBED_MIN_CHARS) {
      console.warn(`[embeddings] a ${only.length}-char text was rejected as-is; storing the fallback vector`);
      return embedSplitting(provider, [EMBED_FALLBACK_TEXT]);
    }
    return embedSplitting(provider, [capEmbedText(only, Math.max(EMBED_MIN_CHARS, Math.floor(only.length / 2)))]);
  }
}
