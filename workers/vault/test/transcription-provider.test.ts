/**
 * WorkersAiProvider + pipeline body-transform unit tests (cloud#56).
 *
 * These need no DO/R2/AI binding — the provider takes an injected
 * `WorkersAiLike` stub, and the body transforms are pure. They pin the
 * spike's hard-won constraints (base64-STRING input, duration metering, the
 * 25 MB ceiling incl. its exact boundary (cloud#67), the 4002/too-long
 * terminal mapping) and the "never destroy content" marker policy.
 */
import { describe, expect, it } from "vitest";
import {
  WorkersAiProvider,
  WHISPER_MODEL,
  MAX_TRANSCRIBE_BYTES,
  type WorkersAiLike,
} from "../src/transcription/workers-ai.ts";
import {
  bodyWithTranscript,
  bodyWithFailureMarker,
  bodyWithPendingRestored,
  segmentPart,
  pendingMarker,
  unavailableMarker,
  TRANSCRIPT_UNAVAILABLE,
  TRANSCRIPT_LIMIT_REACHED,
} from "../src/transcription/pipeline.ts";
import { TranscriptionError } from "@openparachute/core/src/transcription/provider.ts";

/** A stub AI binding that records the last call and returns a scripted result. */
function stubAi(
  impl: (model: string, inputs: { audio: string } & Record<string, unknown>) => unknown,
): WorkersAiLike & { calls: { model: string; audio: string }[] } {
  const calls: { model: string; audio: string }[] = [];
  return {
    calls,
    async run(model, inputs) {
      calls.push({ model, audio: inputs.audio });
      return impl(model, inputs) as any;
    },
  };
}

describe("WorkersAiProvider", () => {
  const input = (bytes: Uint8Array) => ({
    audio: bytes,
    filename: "memo.webm",
    mimeType: "audio/webm",
  });

  it("passes audio as a base64 STRING and returns text + duration (metered)", async () => {
    const raw = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const ai = stubAi(() => ({ text: "hello world", transcription_info: { duration: 42.5 } }));
    const provider = new WorkersAiProvider(ai);

    const result = await provider.transcribe(input(raw));

    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0]!.model).toBe(WHISPER_MODEL);
    // The audio must be a base64 STRING that decodes back to the exact bytes.
    expect(typeof ai.calls[0]!.audio).toBe("string");
    expect([...Buffer.from(ai.calls[0]!.audio, "base64")]).toEqual([...raw]);
    // Metering rides `transcription_info.duration` (the usage field is zeros).
    expect(result).toEqual({ text: "hello world", audioSeconds: 42.5 });
  });

  it("zero-copy encode uses the exact view window (subarray with a non-zero byteOffset)", async () => {
    // A Uint8Array that is a VIEW into a larger buffer — the encode must send
    // ONLY the view's bytes, not the whole underlying ArrayBuffer. Guards the
    // `Buffer.from(buffer, byteOffset, byteLength)` zero-copy path.
    const backing = new Uint8Array([9, 9, 10, 20, 30, 40, 99, 99]);
    const view = backing.subarray(2, 6); // [10,20,30,40], byteOffset 2, length 4
    const ai = stubAi(() => ({ text: "ok" }));
    await new WorkersAiProvider(ai).transcribe({ audio: view, filename: "m.webm", mimeType: "audio/webm" });
    expect([...Buffer.from(ai.calls[0]!.audio, "base64")]).toEqual([10, 20, 30, 40]);
  });

  it("omits audioSeconds when the model reports no duration", async () => {
    const ai = stubAi(() => ({ text: "no duration here" }));
    const result = await new WorkersAiProvider(ai).transcribe(input(new Uint8Array([1, 2, 3])));
    expect(result).toEqual({ text: "no duration here" });
    expect("audioSeconds" in result).toBe(false);
  });

  it("rejects oversized audio non-retriably BEFORE calling the model", async () => {
    const ai = stubAi(() => ({ text: "should not be reached" }));
    const provider = new WorkersAiProvider(ai, { maxBytes: 8 });
    await expect(provider.transcribe(input(new Uint8Array(9)))).rejects.toMatchObject({
      name: "TranscriptionError",
      code: "audio_too_large",
      retriable: false,
    });
    expect(ai.calls).toHaveLength(0); // never touched the model
  });

  it("cloud#67: near-ceiling boundary at the REAL constant — exactly MAX_TRANSCRIBE_BYTES passes, one byte over is gated", async () => {
    // The committed version of the manual live-staging boundary check
    // (24 MB passed / 26 MB gated): the ceiling is a strict `>` against the
    // exported constant, so drifting it (or flipping `>` to `>=`) fails here.
    // Memory note: at-ceiling is the DESIGNED production peak (~25 MB raw +
    // ~33 MB base64 — see the constant's memory math), safe in the test isolate.
    const ai = stubAi(() => ({ text: "at the ceiling" }));
    const provider = new WorkersAiProvider(ai); // default ceiling — no override

    const atCeiling = await provider.transcribe(input(new Uint8Array(MAX_TRANSCRIBE_BYTES)));
    expect(atCeiling.text).toBe("at the ceiling");
    expect(ai.calls).toHaveLength(1);

    await expect(provider.transcribe(input(new Uint8Array(MAX_TRANSCRIBE_BYTES + 1)))).rejects.toMatchObject({
      name: "TranscriptionError",
      code: "audio_too_large",
      retriable: false,
    });
    expect(ai.calls).toHaveLength(1); // the model never saw the oversized one
  });

  it("maps a 4002 / too-long inference error to a non-retriable audio_too_long", async () => {
    const ai = stubAi(() => {
      throw new Error("InferenceUpstreamError: code 4002 request too long");
    });
    await expect(new WorkersAiProvider(ai).transcribe(input(new Uint8Array([1])))).rejects.toMatchObject({
      code: "audio_too_long",
      retriable: false,
    });
  });

  it("maps a 3030 / decode failure to a non-retriable audio_decode_failed", async () => {
    const ai = stubAi(() => {
      throw new Error("3030: Failed to decode audio file. Ensure it is a valid audio file.");
    });
    await expect(new WorkersAiProvider(ai).transcribe(input(new Uint8Array([1])))).rejects.toMatchObject({
      code: "audio_decode_failed",
      retriable: false,
    });
  });

  it("propagates a generic model error as a plain Error (worker treats it retriable)", async () => {
    const ai = stubAi(() => {
      throw new Error("transient upstream 503");
    });
    const err = await new WorkersAiProvider(ai).transcribe(input(new Uint8Array([1]))).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TranscriptionError);
  });

  it("throws a retriable plain Error when the response has no text field", async () => {
    const ai = stubAi(() => ({ transcription_info: { duration: 1 } }));
    const err = await new WorkersAiProvider(ai).transcribe(input(new Uint8Array([1]))).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TranscriptionError);
  });

  it("is unavailable + terminally fails when the AI binding is unbound", async () => {
    const provider = new WorkersAiProvider(undefined);
    expect((await provider.available()).ok).toBe(false);
    await expect(provider.transcribe(input(new Uint8Array([1])))).rejects.toMatchObject({
      code: "missing_provider",
      retriable: false,
    });
  });
});

describe("pipeline body transforms (never destroy content)", () => {
  const memo = (marker: string) =>
    `# 🎙️ Voice memo\n\n_Recorded sometime._\n\n${marker}\n\n![[memo.webm]]\n`;

  it("replaces the pending placeholder with the transcript in place", () => {
    expect(bodyWithTranscript(memo("_Transcript pending._"), "the words")).toBe(memo("the words"));
  });

  it("a retried success replaces a prior unavailable marker in the same spot", () => {
    expect(bodyWithTranscript(memo(TRANSCRIPT_UNAVAILABLE), "recovered")).toBe(memo("recovered"));
  });

  it("a success after a cap reset replaces the limit marker", () => {
    expect(bodyWithTranscript(memo(TRANSCRIPT_LIMIT_REACHED), "back on")).toBe(memo("back on"));
  });

  it("inserts transcript text verbatim even when it contains $& / $1", () => {
    const tricky = "cost $5 and $&{ and $1 dollar";
    expect(bodyWithTranscript("x _Transcript pending._ y", tricky)).toBe(`x ${tricky} y`);
  });

  it("appends (never overwrites) when the user edited the marker away", () => {
    expect(bodyWithTranscript("my own notes", "transcript")).toBe("my own notes\n\ntranscript");
  });

  it("failure marker replaces the placeholder", () => {
    expect(bodyWithFailureMarker(memo("_Transcript pending._"), TRANSCRIPT_UNAVAILABLE)).toBe(
      memo(TRANSCRIPT_UNAVAILABLE),
    );
  });

  it("failure marker is idempotent — never stacks", () => {
    const once = memo(TRANSCRIPT_UNAVAILABLE);
    expect(bodyWithFailureMarker(once, TRANSCRIPT_UNAVAILABLE)).toBe(once);
  });

  it("limit marker appends when the placeholder is gone", () => {
    expect(bodyWithFailureMarker("edited body", TRANSCRIPT_LIMIT_REACHED)).toBe(
      `edited body\n\n${TRANSCRIPT_LIMIT_REACHED}`,
    );
  });
});

describe("per-segment slots (voice W2 — byte-exact cross-door markers)", () => {
  // A three-part memo body: one pending marker per segment, N = index + 1.
  const threePartBody = (p1: string, p2: string, p3: string) =>
    `# 🎙️ Voice memo\n\n${p1}\n\n${p2}\n\n${p3}\n\n![[memo.webm]]\n`;

  it("segmentPart maps a valid segment_index to N = index + 1, else undefined", () => {
    expect(segmentPart({ segment_index: 0 })).toBe(1);
    expect(segmentPart({ segment_index: 2 })).toBe(3);
    expect(segmentPart({})).toBeUndefined();
    expect(segmentPart(undefined)).toBeUndefined();
    expect(segmentPart({ segment_index: -1 })).toBeUndefined();
    expect(segmentPart({ segment_index: 1.5 })).toBeUndefined();
    expect(segmentPart({ segment_index: "2" })).toBeUndefined();
  });

  it("the exact parted marker strings (the contract the bun vault ships identically)", () => {
    expect(pendingMarker(1)).toBe("_Transcript pending (part 1)._");
    expect(pendingMarker(3)).toBe("_Transcript pending (part 3)._");
    expect(unavailableMarker(2)).toBe("_Transcription unavailable (part 2)._");
    // Un-parted (bare) fallbacks are byte-identical to pre-W2.
    expect(pendingMarker()).toBe("_Transcript pending._");
    expect(unavailableMarker()).toBe(TRANSCRIPT_UNAVAILABLE);
  });

  it("a segment success replaces ONLY its own part slot, leaving the others", () => {
    const body = threePartBody(
      "_Transcript pending (part 1)._",
      "_Transcript pending (part 2)._",
      "_Transcript pending (part 3)._",
    );
    const after = bodyWithTranscript(body, "hello from part two", 2);
    expect(after).toBe(
      threePartBody("_Transcript pending (part 1)._", "hello from part two", "_Transcript pending (part 3)._"),
    );
  });

  it("part 1 vs part 12 — the number is anchored, no false slot match", () => {
    const body = "_Transcript pending (part 1)._ and _Transcript pending (part 12)._";
    // Replacing part 1 must not touch part 12's marker.
    expect(bodyWithTranscript(body, "ONE", 1)).toBe("ONE and _Transcript pending (part 12)._");
  });

  it("a parted failure marker replaces only its own pending slot", () => {
    const body = threePartBody(
      "_Transcript pending (part 1)._",
      "_Transcript pending (part 2)._",
      "_Transcript pending (part 3)._",
    );
    const after = bodyWithFailureMarker(body, unavailableMarker(2), 2);
    expect(after).toBe(
      threePartBody(
        "_Transcript pending (part 1)._",
        "_Transcription unavailable (part 2)._",
        "_Transcript pending (part 3)._",
      ),
    );
  });

  it("limit-terminal on a segment writes the UN-PARTED limit marker into that slot only", () => {
    const body = threePartBody(
      "_Transcript pending (part 1)._",
      "_Transcript pending (part 2)._",
      "_Transcript pending (part 3)._",
    );
    const after = bodyWithFailureMarker(body, TRANSCRIPT_LIMIT_REACHED, 2);
    expect(after).toBe(
      threePartBody("_Transcript pending (part 1)._", TRANSCRIPT_LIMIT_REACHED, "_Transcript pending (part 3)._"),
    );
  });

  it("a retried success replaces a prior parted unavailable marker in its slot", () => {
    const body = threePartBody(
      "already part one text",
      "_Transcription unavailable (part 2)._",
      "_Transcript pending (part 3)._",
    );
    expect(bodyWithTranscript(body, "recovered part two", 2)).toBe(
      threePartBody("already part one text", "recovered part two", "_Transcript pending (part 3)._"),
    );
  });

  it("bodyWithPendingRestored restores a part's pending marker over its unavailable marker", () => {
    const body = threePartBody(
      "_Transcript pending (part 1)._",
      "_Transcription unavailable (part 2)._",
      "done part three",
    );
    expect(bodyWithPendingRestored(body, 2)).toBe(
      threePartBody("_Transcript pending (part 1)._", "_Transcript pending (part 2)._", "done part three"),
    );
  });

  it("bodyWithPendingRestored (bare) restores the pending marker over unavailable OR limit", () => {
    const memo = (m: string) => `# 🎙️ Voice memo\n\n${m}\n\n![[memo.webm]]\n`;
    expect(bodyWithPendingRestored(memo(TRANSCRIPT_UNAVAILABLE))).toBe(memo("_Transcript pending._"));
    expect(bodyWithPendingRestored(memo(TRANSCRIPT_LIMIT_REACHED))).toBe(memo("_Transcript pending._"));
    // Nothing terminal to restore → untouched (never inject a spurious spinner).
    expect(bodyWithPendingRestored(memo("user wrote this"))).toBe(memo("user wrote this"));
  });

  it("a segment success appends (never destroys) when its slot marker is gone", () => {
    const body = "# memo\n\nuser rewrote everything\n";
    expect(bodyWithTranscript(body, "part two text", 2)).toBe(`${body}\n\npart two text`);
  });
});
