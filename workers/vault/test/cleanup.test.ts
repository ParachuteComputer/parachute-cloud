/**
 * Transcript CLEANUP orchestration (cloud voice cleanup pass) — the model call
 * + faithfulness guard + soft-fail, wired together. A stub text generator
 * stands in for the Workers AI binding, so these run with no DO/AI.
 *
 * Pins: a faithful clean is accepted (model params: temperature 0, capped
 * max_tokens, system+user messages); a hallucination is discarded by the guard
 * (→ raw); and EVERY failure path (unbound / thrown / empty output / empty
 * input) soft-fails to the raw transcript so cleanup can never block a note.
 */
import { describe, expect, it } from "vitest";
import {
  cleanupTranscript,
  CLEANUP_MODEL,
  type TextGeneratorLike,
} from "../src/transcription/cleanup.ts";

type Call = { model: string; inputs: { messages: { role: string; content: string }[] } & Record<string, unknown> };

/** A stub generator that records calls and returns a scripted `{ response }`. */
function stubGen(
  impl: (raw: string) => { response?: unknown },
): TextGeneratorLike & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async run(model, inputs) {
      calls.push({ model, inputs });
      const userMsg = inputs.messages.find((m) => m.role === "user")?.content ?? "";
      return impl(userMsg) as { response?: unknown } & Record<string, unknown>;
    },
  };
}

describe("cleanupTranscript", () => {
  it("accepts a faithful clean → cleaned text, and calls the model correctly", async () => {
    const raw = "um so i went to the uh store you know and it was fine";
    const gen = stubGen(() => ({ response: "I went to the store, and it was fine." }));

    const res = await cleanupTranscript(gen, raw);

    expect(res.cleaned).toBe(true);
    expect(res.text).toBe("I went to the store, and it was fine.");

    // Model wiring: right model, temperature 0, capped max_tokens, 2 messages.
    expect(gen.calls).toHaveLength(1);
    const call = gen.calls[0]!;
    expect(call.model).toBe(CLEANUP_MODEL);
    expect(call.inputs.temperature).toBe(0);
    expect(typeof call.inputs.max_tokens).toBe("number");
    expect(call.inputs.max_tokens as number).toBeGreaterThanOrEqual(64);
    // ~1.2× the estimated input tokens (chars/4) — a structural runaway cap.
    expect(call.inputs.max_tokens as number).toBe(Math.max(64, Math.ceil((raw.length / 4) * 1.2)));
    expect(call.inputs.messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(call.inputs.messages[1]!.content).toBe(raw);
  });

  it("DISCARDS a hallucinated clean via the guard → returns RAW (cleaned:false)", async () => {
    const raw = "i really enjoy algorithms";
    const gen = stubGen(() => ({ response: "I really enjoy Al Gore's ideas." }));

    const res = await cleanupTranscript(gen, raw);

    expect(res.cleaned).toBe(false);
    expect(res.text).toBe(raw);
    expect(res.reason).toMatch(/guard rejected/);
  });

  it("soft-fails to raw when the model call THROWS (never blocks the transcript)", async () => {
    const raw = "the transcript still needs to land";
    const gen: TextGeneratorLike = {
      async run() {
        throw new Error("workers-ai 500");
      },
    };

    const res = await cleanupTranscript(gen, raw);

    expect(res.cleaned).toBe(false);
    expect(res.text).toBe(raw);
    expect(res.reason).toMatch(/cleanup call failed/);
  });

  it("soft-fails to raw when the model returns an empty/blank response", async () => {
    const raw = "keep me exactly as I am";
    const res = await cleanupTranscript(stubGen(() => ({ response: "   " })), raw);
    expect(res.cleaned).toBe(false);
    expect(res.text).toBe(raw);
    expect(res.reason).toMatch(/empty cleanup output/);
  });

  it("soft-fails to raw (no model call) when no generator is bound", async () => {
    const res = await cleanupTranscript(undefined, "some raw text");
    expect(res.cleaned).toBe(false);
    expect(res.text).toBe("some raw text");
    expect(res.reason).toMatch(/not bound/);
  });

  it("returns raw without calling the model for an empty transcript", async () => {
    const gen = stubGen(() => ({ response: "should not run" }));
    const res = await cleanupTranscript(gen, "   ");
    expect(res.cleaned).toBe(false);
    expect(res.text).toBe("   ");
    expect(gen.calls).toHaveLength(0);
  });

  it("honors a custom maxTokensFactor", async () => {
    const raw = "a".repeat(400); // ~100 estimated tokens
    const gen = stubGen(() => ({ response: raw })); // identical → guard accepts as no-op
    await cleanupTranscript(gen, raw, { maxTokensFactor: 2 });
    expect(gen.calls[0]!.inputs.max_tokens).toBe(Math.max(64, Math.ceil((400 / 4) * 2)));
  });
});
