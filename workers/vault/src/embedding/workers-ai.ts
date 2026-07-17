/**
 * `workers-ai` — the cloud embedding provider (semantic search MVP, C2).
 *
 * Implements core's runtime-agnostic `EmbeddingProvider` interface (the
 * semantic-search seam, parachute-vault vault#602) against Cloudflare Workers
 * AI: `@cf/baai/bge-m3` — the SAME model family Aaron's self-host door runs
 * via Ollama (the plan's Aaron-ratified "one model, both doors" recommendation
 * — SEMANTIC-MVP-PLAN.md §7 open call 2): multilingual, a ~60k-token context
 * window (core's chunker targets ~450-token chunks, so truncation is not
 * expected in practice — `truncate_inputs: true` is still passed so a
 * pathological unsplittable chunk truncates instead of erroring the whole
 * batch; chunker.ts documents truncation as the PROVIDER's job, not
 * chunking's).
 *
 * Model + wire shape were confirmed against `@cloudflare/workers-types`
 * (the authoritative typed catalog, not guessed): calling `@cf/baai/bge-m3`
 * with `{ text: string | string[] }` (the `Ai_Cf_Baai_Bge_M3_Input_Embedding`
 * variant) returns `Ai_Cf_Baai_Bge_M3_Output_Embedding` — `{ shape?,
 * data?: number[][], pooling? }` — byte-identical in shape to
 * `@cf/baai/bge-base-en-v1.5`'s response. (The model ALSO exposes a separate
 * `{ query, contexts[] }` reranking-style input that returns per-context
 * SCORES instead of vectors — unused here; this provider always calls the
 * plain batch-embedding form.) No fallback model was needed — bge-m3 is
 * live on Workers AI.
 *
 * Structurally a sibling of `transcription/workers-ai.ts` (same
 * "unavailable = binding absent, no network probe" contract, same
 * config-vs-transient error split) — the embedding seam clones the
 * transcription seam's provider shape, not just its interface.
 */

import {
  EmbeddingError,
  type EmbeddingProvider,
  type EmbedInput,
  type EmbedResult,
  type ProviderAvailability,
} from "@openparachute/core/src/embedding/provider.js";

/** The Workers AI embedding model (confirmed live via @cloudflare/workers-types). */
export const EMBEDDING_MODEL = "@cf/baai/bge-m3";

/**
 * bge-m3's dense-embedding output dimensionality — 1024 (the plan's own
 * model-choice writeup cites this: 4 KB/note = 1024 × 4-byte float32).
 * Refined defensively from the first real response (mirrors the self-host
 * `ExternalApiEmbeddingProvider`'s `dims` field) in case Workers AI ever
 * changes it — never trusted blindly.
 */
const DEFAULT_DIMS = 1024;

/**
 * The narrow slice of the Workers AI binding this provider depends on — just
 * `run(model, { text, truncate_inputs })`. Declared locally (mirrors
 * `transcription/workers-ai.ts`'s `WorkersAiLike`) so the DO can inject a
 * plain stub in tests without a live AI binding.
 */
export interface WorkersAiEmbedLike {
  run(
    model: string,
    inputs: { text: string[]; truncate_inputs?: boolean },
  ): Promise<{ data?: unknown; shape?: unknown } & Record<string, unknown>>;
}

export class WorkersAiEmbeddingProvider implements EmbeddingProvider {
  readonly name = "workers-ai";
  readonly model = EMBEDDING_MODEL;
  /** Best-known dims — refined on the first successful embed() response (see DEFAULT_DIMS doc). */
  dims: number;

  private readonly ai: WorkersAiEmbedLike | undefined;

  constructor(ai: WorkersAiEmbedLike | undefined) {
    this.ai = ai;
    this.dims = DEFAULT_DIMS;
  }

  /**
   * Availability is purely "is the AI binding present" — no inference, no
   * network probe (mirrors the transcription provider; the capability flag
   * reads this on every landing GET, so it must stay cheap).
   */
  async available(): Promise<ProviderAvailability> {
    if (!this.ai) return { ok: false, reason: "Workers AI binding not configured" };
    return { ok: true };
  }

  async embed(input: EmbedInput): Promise<EmbedResult> {
    if (!this.ai) {
      throw new EmbeddingError("Workers AI binding not configured", {
        code: "missing_provider",
        retriable: false,
      });
    }
    if (input.texts.length === 0) {
      return { vectors: [], model: this.model, dims: this.dims };
    }

    let out: { data?: unknown } & Record<string, unknown>;
    try {
      out = await this.ai.run(this.model, { text: input.texts, truncate_inputs: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // A malformed/over-length request is a config/input problem the caller
      // must fix — retrying the SAME input just re-fails (mirrors the
      // transcription provider's terminal/transient split).
      if (/\btoo long\b|\bexceed(s|ed)?\b|context.?length|\b400\b/i.test(msg)) {
        throw new EmbeddingError(`embedding input rejected: ${msg}`, {
          code: "input_rejected",
          retriable: false,
        });
      }
      // Everything else (transient upstream, network) stays retriable (a
      // plain Error) — the alarm drain leaves the chunk stale and retries.
      throw err;
    }

    if (!Array.isArray(out.data)) {
      throw new Error("workers-ai embedding response missing `data` array");
    }
    const vectors = (out.data as unknown[]).map((row) => {
      if (!Array.isArray(row)) throw new Error("workers-ai embedding response `data` row is not an array");
      return new Float32Array(row as number[]);
    });
    if (vectors.length !== input.texts.length) {
      throw new Error(
        `workers-ai returned ${vectors.length} vector(s) for ${input.texts.length} input text(s)`,
      );
    }
    if (vectors[0]) this.dims = vectors[0].length;
    return { vectors, model: this.model, dims: this.dims };
  }
}
