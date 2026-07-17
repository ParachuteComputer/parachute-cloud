/**
 * Embedding off-switch resolution unit tests (semantic search MVP, C2).
 * Mirrors self-host's `src/embedding/select.test.ts` coverage for the
 * identical off-switch rule.
 */
import { describe, expect, it } from "vitest";
import { embeddingsExplicitlyDisabled } from "../src/embedding/select.ts";

describe("embeddingsExplicitlyDisabled", () => {
  it("is false when unset", () => {
    expect(embeddingsExplicitlyDisabled({})).toBe(false);
  });

  it("is false for the explicit 'true' value", () => {
    expect(embeddingsExplicitlyDisabled({ EMBEDDINGS_ENABLED: "true" })).toBe(false);
  });

  it("is true only for the literal 'false' (case-insensitive, trimmed)", () => {
    expect(embeddingsExplicitlyDisabled({ EMBEDDINGS_ENABLED: "false" })).toBe(true);
    expect(embeddingsExplicitlyDisabled({ EMBEDDINGS_ENABLED: "FALSE" })).toBe(true);
    expect(embeddingsExplicitlyDisabled({ EMBEDDINGS_ENABLED: "  false  " })).toBe(true);
  });

  it("is false for any other value (typo, empty string, etc.)", () => {
    expect(embeddingsExplicitlyDisabled({ EMBEDDINGS_ENABLED: "0" })).toBe(false);
    expect(embeddingsExplicitlyDisabled({ EMBEDDINGS_ENABLED: "" })).toBe(false);
    expect(embeddingsExplicitlyDisabled({ EMBEDDINGS_ENABLED: "no" })).toBe(false);
  });
});
