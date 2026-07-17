/**
 * WorkersAiEmbeddingProvider unit tests (semantic search MVP, C2).
 *
 * Needs no DO/AI binding — the provider takes an injected `WorkersAiEmbedLike`
 * stub. Pins the confirmed-against-`@cloudflare/workers-types` request/
 * response shape (`{ text: string[] }` → `{ data: number[][] }`, identical to
 * `@cf/baai/bge-base-en-v1.5`), the `truncate_inputs: true` request flag, the
 * terminal/transient error split (mirrors `WorkersAiProvider`'s), and the
 * `dims` self-refinement.
 */
import { describe, expect, it } from "vitest";
import {
  WorkersAiEmbeddingProvider,
  EMBEDDING_MODEL,
  type WorkersAiEmbedLike,
} from "../src/embedding/workers-ai.ts";
import { EmbeddingError } from "@openparachute/core/src/embedding/provider.ts";

/** A stub AI binding that records the last call and returns a scripted result. */
function stubAi(
  impl: (model: string, inputs: { text: string[]; truncate_inputs?: boolean }) => unknown,
): WorkersAiEmbedLike & { calls: { model: string; text: string[]; truncate_inputs?: boolean }[] } {
  const calls: { model: string; text: string[]; truncate_inputs?: boolean }[] = [];
  return {
    calls,
    async run(model, inputs) {
      calls.push({ model, text: inputs.text, truncate_inputs: inputs.truncate_inputs });
      return impl(model, inputs) as any;
    },
  };
}

describe("WorkersAiEmbeddingProvider", () => {
  it("embeds a batch of texts, preserving order, and passes truncate_inputs: true", async () => {
    const ai = stubAi(() => ({ data: [[0.1, 0.2], [0.3, 0.4], [0.5, 0.6]], shape: [3, 2] }));
    const provider = new WorkersAiEmbeddingProvider(ai);

    const result = await provider.embed({ texts: ["a", "b", "c"] });

    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0]!.model).toBe(EMBEDDING_MODEL);
    expect(ai.calls[0]!.text).toEqual(["a", "b", "c"]);
    expect(ai.calls[0]!.truncate_inputs).toBe(true);
    expect(result.vectors).toHaveLength(3);
    // Float32 round-trip loses precision vs the JS-number literals — compare
    // against the SAME Float32Array conversion, not the raw doubles.
    expect(result.vectors[0]).toEqual(new Float32Array([0.1, 0.2]));
    expect(result.vectors[2]).toEqual(new Float32Array([0.5, 0.6]));
    expect(result.model).toBe(EMBEDDING_MODEL);
  });

  it("refines dims from the first real response", async () => {
    const ai = stubAi(() => ({ data: [new Array(1024).fill(0.01)] }));
    const provider = new WorkersAiEmbeddingProvider(ai);
    expect(provider.dims).toBe(1024); // documented default, pre-embed

    await provider.embed({ texts: ["x"] });
    expect(provider.dims).toBe(1024); // confirmed from the real response too
  });

  it("empty input returns empty vectors without calling the model", async () => {
    const ai = stubAi(() => ({ data: [["should not be reached"]] }));
    const result = await new WorkersAiEmbeddingProvider(ai).embed({ texts: [] });
    expect(result).toEqual({ vectors: [], model: EMBEDDING_MODEL, dims: 1024 });
    expect(ai.calls).toHaveLength(0);
  });

  it("is unavailable + terminally fails when the AI binding is unbound", async () => {
    const provider = new WorkersAiEmbeddingProvider(undefined);
    expect((await provider.available()).ok).toBe(false);
    await expect(provider.embed({ texts: ["x"] })).rejects.toMatchObject({
      name: "EmbeddingError",
      code: "missing_provider",
      retriable: false,
    });
  });

  it("is available when the AI binding is present", async () => {
    const provider = new WorkersAiEmbeddingProvider(stubAi(() => ({ data: [[1]] })));
    expect((await provider.available()).ok).toBe(true);
  });

  it("maps a too-long/context-length error to a non-retriable input_rejected", async () => {
    const ai = stubAi(() => {
      throw new Error("input exceeds the model's context length");
    });
    await expect(new WorkersAiEmbeddingProvider(ai).embed({ texts: ["x"] })).rejects.toMatchObject({
      name: "EmbeddingError",
      code: "input_rejected",
      retriable: false,
    });
  });

  it("propagates a generic model error as a plain Error (caller treats it retriable)", async () => {
    const ai = stubAi(() => {
      throw new Error("transient upstream 503");
    });
    const err = await new WorkersAiEmbeddingProvider(ai).embed({ texts: ["x"] }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(EmbeddingError);
  });

  it("throws a plain Error when the response is missing the data array", async () => {
    const ai = stubAi(() => ({ shape: [1, 1024] }));
    const err = await new WorkersAiEmbeddingProvider(ai).embed({ texts: ["x"] }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(EmbeddingError);
  });

  it("throws a plain Error on a vector-count mismatch", async () => {
    const ai = stubAi(() => ({ data: [[0.1, 0.2]] })); // 1 vector for 2 texts
    const err = await new WorkersAiEmbeddingProvider(ai).embed({ texts: ["a", "b"] }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).toContain("2 input text(s)");
  });
});
