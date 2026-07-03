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
 *     A ZERO-COPY `Buffer` VIEW over the audio's ArrayBuffer + `.toString(
 *     "base64")` (nodejs_compat) — NOT `Buffer.from(uint8array)` (which copies)
 *     nor a `btoa(String.fromCharCode(...))` binary-string round-trip (which
 *     roughly triples peak memory). This runs inside a 128 MB Durable Object.
 *   - **25 MB raw ceiling under the 128 MB DO** — the encode's peak is
 *     ~2.33 × N (raw view + ~1.33 × N base64 string) plus the DO baseline, and
 *     an OOM in the synchronous encode is UNCATCHABLE, so the ceiling is
 *     enforced BEFORE the encode: the DO head-size-gates on
 *     {@link MAX_TRANSCRIBE_BYTES} before the R2 read, and this provider
 *     re-checks `byteLength` before the encode. Over → non-retriable
 *     `audio_too_large` (a retry can't shrink the file). See the constant's
 *     doc for the full memory math + why 25, not 45.
 *   - **~240 s inference wall-clock (≈60 min of audio per call)** — Workers AI
 *     surfaces an over-length job as a `4002` error AFTER ~240 s. We map that
 *     (and its siblings) to a non-retriable `audio_too_long`: each blind retry
 *     would burn another ~4 minutes for the same guaranteed failure. Chunking
 *     long audio is a follow-on; v1 rejects with a clear marker.
 *   - The response carries `text` + `transcription_info.duration` (METER ON
 *     THIS — the `usage` field is all-zeros for this model) + word timestamps +
 *     vtt "for free"; v1 only consumes `text` + `duration`.
 *
 * ## Cleanup pass (SHIPPED — lives in the DO, not here)
 *
 * This provider deliberately returns the RAW whisper `text` unchanged. The
 * transcript-cleanup pass (punctuate/paragraph/strip-fillers via a text model,
 * gated by the deterministic faithfulness guard) lives in the DO orchestration
 * (`VaultDO.transcribeOne` → `transcription/cleanup.ts` + `faithfulness.ts`),
 * NOT in this provider. It runs there — rather than at the earlier "between
 * `ai.run` and `return`" seam — because raw-preservation is a DO concern: the
 * DO writes the cleaned view to the note body while stamping the RAW transcript
 * into note + attachment metadata, and it keeps metering on the raw
 * `audioSeconds` this provider reports (cleanup never touches the meter). The
 * provider's contract stays "audio → raw text"; cleanup is a cloud-runtime
 * display policy on top.
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
 * Raw-audio ceiling — **25 MB**, chosen with real headroom under the 128 MB DO
 * isolate cap (NOT the earlier 45 MB, which was dangerously close).
 *
 * ## The memory math (why 25, not 45)
 *
 * A DO isolate is hard-capped at ~128 MB. Transcribing one attachment holds,
 * transiently and concurrently:
 *   - the raw audio: N bytes (read from R2 as one `ArrayBuffer` → `Uint8Array`);
 *   - the base64 string: ~1.33 × N bytes (base64 is 4/3, stored as a 1-byte
 *     ASCII/Latin-1 string in V8) — allocated by `toString("base64")` while the
 *     raw bytes are still referenced (the provider still holds `input.audio`);
 *   - on top of the DO baseline: core + the vault's SQLite pages + config +
 *     the Workers-AI subrequest marshalling of that base64 string.
 *
 * So peak ≈ **2.33 × N + baseline**. The encode is ZERO-COPY (a `Buffer` VIEW
 * over the existing `ArrayBuffer` — see `transcribe`), which removes the extra
 * N-byte copy `Buffer.from(uint8array)` would have made, but 1.33 × N for the
 * base64 string is irreducible without streaming (Workers AI wants the whole
 * string). At N = 25 MB → ~58 MB of audio+base64, leaving comfortable room for
 * the baseline + marshalling under 128 MB. At the old 45 MB it was ~105 MB
 * before baseline — an OOM waiting for a warm DO.
 *
 * **Critically**, the OOM would strike inside the SYNCHRONOUS `toString`, which
 * can tear down the isolate UNCATCHABLY — so the ceiling MUST be enforced
 * BEFORE the encode (and before the R2 read). The DO head-size-gates on this
 * constant before ever reading the object (`VaultDO.transcribeOne`), and this
 * provider re-checks `byteLength` before the encode as a backstop; a file over
 * the ceiling fails non-retriably (`audio_too_large`) and never reaches the
 * encode. Uploads are already capped at 100 MB, so 25–100 MB files are all
 * head-gated to a terminal marker (never spin).
 *
 * 25 MB is generous for a voice NOTE: compressed opus/m4a at ~24–32 kbps ≈
 * 100+ minutes; PCM wav 16 kHz mono ≈ 13 minutes. Genuinely long recordings
 * hit the ~240 s inference wall first (`4002` → terminal `audio_too_long`) or
 * need chunking (a later phase).
 */
export const MAX_TRANSCRIBE_BYTES = 25 * 1024 * 1024;

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
      // A retry can't shrink the file — terminal. The DO head-size-gates BEFORE
      // it reads R2 (so an oversized file never reaches this encode, where an
      // OOM would be uncatchable); this is the provider-level backstop for that
      // gate, still BEFORE the allocating encode below.
      throw new TranscriptionError(
        `audio too large (${input.audio.byteLength} bytes > ${this.maxBytes}-byte ceiling)`,
        { code: "audio_too_large", retriable: false },
      );
    }

    // base64 STRING input (spike constraint), ZERO-COPY: a `Buffer` VIEW over
    // the audio's existing ArrayBuffer window — `Buffer.from(uint8array)` would
    // COPY the N bytes, adding an N-byte transient on top of the ~1.33 × N
    // base64 string. Only the base64 string is a fresh allocation. See the
    // MAX_TRANSCRIBE_BYTES memory math for why this + the 25 MB ceiling keep the
    // encode safely under the 128 MB isolate cap.
    const b64 = Buffer.from(input.audio.buffer, input.audio.byteOffset, input.audio.byteLength).toString("base64");

    let out: { text?: unknown; transcription_info?: { duration?: unknown } } & Record<string, unknown>;
    try {
      out = await this.ai.run(WHISPER_MODEL, { audio: b64 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // A `4002` (or an over-length / inference-upstream failure) surfaces AFTER
      // ~240 s and means the audio exceeds one inference window. Blind-retrying
      // burns ~4 min per attempt for the same guaranteed failure — make it
      // TERMINAL.
      if (/\b4002\b|too long|inferenceupstream|exceed(s|ed)? .*(length|duration|limit)/i.test(msg)) {
        throw new TranscriptionError(`audio too long for a single inference: ${msg}`, {
          code: "audio_too_long",
          retriable: false,
        });
      }
      // A `3030` "Failed to decode" (a corrupt / unsupported / truncated audio
      // file) is ALSO permanent for that file — retrying the same bytes just
      // re-fails, so terminal, not 3 wasted whisper inferences. (Surfaced by the
      // near-ceiling measurement, cloud#56.)
      if (/\b3030\b|failed to decode|could ?n[o']t decode|invalid audio|unsupported (audio|format)/i.test(msg)) {
        throw new TranscriptionError(`audio could not be decoded: ${msg}`, {
          code: "audio_decode_failed",
          retriable: false,
        });
      }
      // Everything else (transient upstream, network) stays retriable (a plain
      // Error → the worker treats it as retriable).
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
