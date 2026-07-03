/**
 * `workers-ai` — the cloud voice-transcription provider (cloud#56).
 *
 * Implements core's runtime-agnostic `TranscriptionProvider` interface (the
 * scribe-fold Phase 1 seam, parachute-vault vault#529) against Cloudflare
 * Workers AI: it base64-encodes the audio and calls
 * `@cf/openai/whisper-large-v3-turbo`, returning the transcript text plus the
 * model-reported audio duration (the metered/plan concern — the DO decrements
 * a monthly minutes balance by it).
 *
 * ## Hard-won constraints from the 2026-07-03 whisper spike (encoded here)
 *
 *   - **Input is a base64 STRING** (`{ audio: "<b64>" }`), NOT a byte array.
 *     `Buffer.from(bytes).toString("base64")` (nodejs_compat) is used instead of
 *     a `btoa(String.fromCharCode(...))` binary-string round-trip — the latter
 *     roughly triples peak memory, and this runs inside a 128 MB Durable Object.
 *   - **~50 MB file ceiling inside the 128 MB DO** — base64 alone is ~1.33× the
 *     raw bytes and the encode holds both buffers transiently, so we REJECT
 *     anything over {@link MAX_TRANSCRIBE_BYTES} (~45 MB) up front with a
 *     non-retriable `audio_too_large` (a retry can't shrink the file). The DO
 *     also size-gates before ever reading R2, so oversized audio never even
 *     lands in memory; this is the provider-level backstop.
 *   - **~240 s inference wall-clock (≈60 min of audio per call)** — Workers AI
 *     surfaces an over-length job as a `4002` error AFTER ~240 s. We map that
 *     (and its siblings) to a non-retriable `audio_too_long`: each blind retry
 *     would burn another ~4 minutes for the same guaranteed failure. Chunking
 *     long audio is a follow-on; v1 rejects with a clear marker.
 *   - The response carries `text` + `transcription_info.duration` (METER ON
 *     THIS — the `usage` field is all-zeros for this model) + word timestamps +
 *     vtt "for free"; v1 only consumes `text` + `duration`.
 *
 * ## Cleanup seam (follow-on PR — deliberately NOT in this PR)
 *
 * whisper-large-v3-turbo output is already punctuated, so it lands in the note
 * body verbatim. A later PR adds a cleanup pass (a researched model) BETWEEN
 * `this.ai.run(...)` returning and the `return` below — it would rewrite
 * `text` while leaving `audioSeconds` (the meter) untouched. Keep that the only
 * insertion point so metering can't drift from the raw model duration.
 */

import {
  TranscriptionError,
  type TranscriptionProvider,
  type TranscribeInput,
  type TranscribeResult,
  type ProviderAvailability,
} from "@openparachute/core/src/transcription/provider.js";

/** The Workers AI transcription model (spike-validated). */
export const WHISPER_MODEL = "@cf/openai/whisper-large-v3-turbo";

/**
 * Raw-audio ceiling (~45 MB). base64 costs ~1.33× and the encode holds both
 * the raw and encoded buffers transiently — inside a 128 MB DO that keeps peak
 * memory comfortably bounded. Files over this fail non-retriably (a retry can't
 * shrink them); chunking is the follow-on for genuinely long recordings.
 */
export const MAX_TRANSCRIBE_BYTES = 45 * 1024 * 1024;

/**
 * The narrow slice of the Workers AI binding this provider depends on — just
 * `run(model, { audio: <base64 string> })`. Declared locally (rather than
 * leaning on the full generated `Ai` type) so the DO can inject a plain stub in
 * tests without a live AI binding, and so the base64-string input contract is
 * documented at the call site.
 */
export interface WorkersAiLike {
  run(
    model: string,
    inputs: { audio: string } & Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<{ text?: unknown; transcription_info?: { duration?: unknown } } & Record<string, unknown>>;
}

export interface WorkersAiProviderOpts {
  /** Override the raw-byte ceiling (tests exercise the rejection path cheaply). */
  maxBytes?: number;
}

export class WorkersAiProvider implements TranscriptionProvider {
  readonly name = "workers-ai";

  private readonly ai: WorkersAiLike | undefined;
  private readonly maxBytes: number;

  constructor(ai: WorkersAiLike | undefined, opts: WorkersAiProviderOpts = {}) {
    this.ai = ai;
    this.maxBytes = opts.maxBytes ?? MAX_TRANSCRIBE_BYTES;
  }

  /**
   * Availability is purely "is the AI binding present" — no inference, no
   * network probe (the capability flag is read on landing reads, so this must
   * stay cheap). Unbound (dev/test without `[ai]`) → not available.
   */
  async available(): Promise<ProviderAvailability> {
    if (!this.ai) return { ok: false, reason: "Workers AI binding not configured" };
    return { ok: true };
  }

  async transcribe(input: TranscribeInput): Promise<TranscribeResult> {
    if (!this.ai) {
      // Config problem, not transient — the operator must bind `[ai]`. Terminal.
      throw new TranscriptionError("Workers AI binding not configured", {
        code: "missing_provider",
        retriable: false,
      });
    }

    if (input.audio.byteLength > this.maxBytes) {
      // A retry can't shrink the file — terminal. The DO size-gates before it
      // ever reads R2; this is the provider-level backstop.
      throw new TranscriptionError(
        `audio too large (${input.audio.byteLength} bytes > ${this.maxBytes}-byte ceiling)`,
        { code: "audio_too_large", retriable: false },
      );
    }

    // base64 STRING input (spike constraint). Buffer (nodejs_compat) is the
    // memory-frugal encoder — no intermediate JS binary string.
    const b64 = Buffer.from(input.audio).toString("base64");

    let out: { text?: unknown; transcription_info?: { duration?: unknown } } & Record<string, unknown>;
    try {
      out = await this.ai.run(WHISPER_MODEL, { audio: b64 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // A `4002` (or an over-length / inference-upstream failure) surfaces AFTER
      // ~240 s and means the audio exceeds one inference window. Blind-retrying
      // burns ~4 min per attempt for the same guaranteed failure — make it
      // TERMINAL. Everything else (transient upstream, network) stays retriable
      // (a plain Error → the worker treats it as retriable).
      if (/\b4002\b|too long|inferenceupstream|exceed(s|ed)? .*(length|duration|limit)/i.test(msg)) {
        throw new TranscriptionError(`audio too long for a single inference: ${msg}`, {
          code: "audio_too_long",
          retriable: false,
        });
      }
      throw err;
    }

    if (typeof out.text !== "string") {
      // Malformed response — retriable (a plain Error).
      throw new Error("workers-ai response missing text field");
    }

    // NOTE (cleanup seam): a follow-on PR rewrites `out.text` through a cleanup
    // model HERE, leaving the duration (the meter) untouched.
    const duration = out.transcription_info?.duration;
    return {
      text: out.text,
      ...(typeof duration === "number" && Number.isFinite(duration) ? { audioSeconds: duration } : {}),
    };
  }
}
