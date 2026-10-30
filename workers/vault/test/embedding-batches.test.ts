/**
 * T-318: the embedding drain must never retry an oversized call forever.
 *
 * On staging the alarm repeated "input exceeded the model context window
 * (64,833 > 60,000 tokens)" every few seconds on a vault of Adam's notes: the
 * drain sliced calls by COUNT only (90 texts), 90 long chunks passed the
 * model's total window, and the next wake re-planned the same call. Core's
 * chunker also leaves one long unbroken line as a single chunk of any size.
 *
 * The stub below behaves like bge-m3 on Workers AI: it rejects a call whose
 * texts add up past its window, or any single text past its per-input limit,
 * with the provider's non-retriable `input_rejected` error.
 */
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  EmbeddingError,
  type EmbeddingProvider,
  type EmbedInput,
  type EmbedResult,
} from "@openparachute/core/src/embedding/provider.ts";
import { chunkNoteContent } from "@openparachute/core/src/embedding/chunker.ts";
import { getNotesPendingEmbedding } from "@openparachute/core/src/embedding/vectors.ts";
import {
  EMBED_FALLBACK_TEXT,
  EMBED_MAX_CHARS_PER_CALL,
  EMBED_MAX_CHARS_PER_TEXT,
  capEmbedText,
  planEmbedBatches,
} from "../src/embedding/batches.ts";
import { WorkersAiEmbeddingProvider } from "../src/embedding/workers-ai.ts";
import { createNote, freshVault, op } from "./helpers.ts";

const MODEL = "test-window-model";

function windowedProvider(opts: { windowChars: number; perTextChars: number; refuse?: string }): EmbeddingProvider & {
  calls: number;
  rejected: number;
} {
  const p = {
    name: "test-window",
    model: MODEL,
    dims: 3,
    calls: 0,
    rejected: 0,
    async available() {
      return { ok: true as const };
    },
    async embed(input: EmbedInput): Promise<EmbedResult> {
      p.calls++;
      const total = input.texts.reduce((n, t) => n + t.length, 0);
      const longest = Math.max(...input.texts.map((t) => t.length));
      const refused = opts.refuse !== undefined && input.texts.some((t) => t.includes(opts.refuse!));
      if (total > opts.windowChars || longest > opts.perTextChars || refused) {
        p.rejected++;
        // The exact wording Workers AI used on staging, through the provider's own mapping.
        throw new EmbeddingError(
          `embedding input rejected: input exceeded the model context window (${total} > ${opts.windowChars} tokens)`,
          { code: "input_rejected", retriable: false },
        );
      }
      return { vectors: input.texts.map(() => new Float32Array([1, 0, 0])), model: MODEL, dims: 3 };
    },
  };
  return p;
}

function doStub(vault: string): DurableObjectStub {
  return env.VAULT.get(env.VAULT.idFromName(vault)) as unknown as DurableObjectStub;
}

/** A long note: `paras` paragraphs of ~400 characters, so the chunker cuts ~1,800-char chunks. */
function longNote(seed: number, paras: number): string {
  const out: string[] = [];
  for (let p = 0; p < paras; p++) {
    out.push(`Paragraph ${p} of note ${seed}. ` + `word${seed}x${p} `.repeat(40).trim());
  }
  return out.join("\n\n");
}

/** Run alarm wakes until nothing is pending (or the bound), the way production drains. */
async function drain(vault: string, provider: EmbeddingProvider, maxWakes = 25): Promise<number> {
  let pending = -1;
  for (let i = 0; i < maxWakes && pending !== 0; i++) {
    await runInDurableObject<DurableObject, void>(doStub(vault), async (inst: any) => {
      inst.__setTestEmbeddingProvider(provider);
      await inst.alarm();
      pending = getNotesPendingEmbedding(inst.store.db, MODEL, 1000).length;
    });
  }
  return pending;
}

async function vectorCount(vault: string, noteId: string): Promise<number> {
  let n = 0;
  await runInDurableObject<DurableObject, void>(doStub(vault), async (inst: any) => {
    n = (inst.store.db.prepare("SELECT COUNT(*) AS n FROM note_vectors WHERE note_id = ?").get(noteId) as { n: number }).n;
  });
  return n;
}

describe("embedding batches (T-318): oversized input is capped and split, not retried forever", () => {
  it("plans calls by total size as well as count, in order", () => {
    const texts = Array.from({ length: 100 }, (_, i) => "x".repeat(1_800 + i));
    const batches = planEmbedBatches(texts, 90);
    expect(batches.flat()).toEqual(texts.map((_, i) => i));
    for (const b of batches) {
      expect(b.length).toBeLessThanOrEqual(90);
      expect(b.reduce((n, i) => n + Math.min(texts[i]!.length, EMBED_MAX_CHARS_PER_TEXT), 0)).toBeLessThanOrEqual(
        EMBED_MAX_CHARS_PER_CALL,
      );
    }
    // A capped giant counts as its capped size and still gets a call.
    expect(planEmbedBatches(["y".repeat(1_000_000)], 90)).toEqual([[0]]);
    // Capping never leaves half a surrogate pair.
    const emoji = "a".repeat(EMBED_MAX_CHARS_PER_TEXT - 1) + "😀";
    expect(capEmbedText(emoji)).toBe("a".repeat(EMBED_MAX_CHARS_PER_TEXT - 1));
  });

  it("a vault of long notes drains under a 60,000-character window", async () => {
    const v = freshVault("ewin");
    expect((await op(v, "")).status).toBe(200);
    const notes: Array<{ id: string; content: string }> = [];
    for (let i = 0; i < 14; i++) {
      const content = longNote(i, 20); // ~8,000 chars → ~5 chunks each, ~70 chunks in all
      notes.push({ id: (await createNote(v, { content, path: `long/n${i}` })).id, content });
    }
    // One unbroken 50,000-character line: the chunker keeps it as one chunk.
    const blob = "z".repeat(50_000);
    const blobNote = await createNote(v, { content: blob, path: "long/blob" });

    const provider = windowedProvider({ windowChars: 60_000, perTextChars: 10_000 });
    expect(await drain(v, provider)).toBe(0);
    for (const n of notes) {
      expect(await vectorCount(v, n.id)).toBe(chunkNoteContent(n.content).filter((c) => c.text.trim()).length);
    }
    expect(await vectorCount(v, blobNote.id)).toBe(1);
    // Nothing is re-sent once embedded: the capped blob reads as fresh.
    const calls = provider.calls;
    expect(await drain(v, provider)).toBe(0);
    expect(provider.calls).toBe(calls);
  }, 120_000);

  it("a text the model refuses for another reason gets the fallback vector and stops coming back", async () => {
    const v = freshVault("erefuse");
    expect((await op(v, "")).status).toBe(200);
    const good = await createNote(v, { content: longNote(300, 6), path: "refuse/good" });
    const bad = await createNote(v, { content: "short note with a ZZ-REFUSED-ZZ marker", path: "refuse/bad" });
    const provider = windowedProvider({ windowChars: 60_000, perTextChars: 10_000, refuse: "ZZ-REFUSED-ZZ" });
    expect(await drain(v, provider)).toBe(0);
    expect(await vectorCount(v, bad.id)).toBe(1);
    expect(await vectorCount(v, good.id)).toBe(chunkNoteContent(longNote(300, 6)).filter((c) => c.text.trim()).length);
    const calls = provider.calls;
    expect(await drain(v, provider)).toBe(0);
    expect(provider.calls).toBe(calls);
  }, 120_000);

  it("a call the model still rejects is split until it fits", async () => {
    const v = freshVault("esplit");
    expect((await op(v, "")).status).toBe(200);
    const notes: Array<{ id: string; content: string }> = [];
    for (let i = 0; i < 8; i++) {
      const content = longNote(100 + i, 20);
      notes.push({ id: (await createNote(v, { content, path: `split/n${i}` })).id, content });
    }
    // A window far below the planned 40,000-character calls (and below one capped text).
    const provider = windowedProvider({ windowChars: 5_000, perTextChars: 5_000 });
    expect(await drain(v, provider)).toBe(0);
    expect(provider.rejected).toBeGreaterThan(0);
    for (const n of notes) {
      expect(await vectorCount(v, n.id)).toBe(chunkNoteContent(n.content).filter((c) => c.text.trim()).length);
    }
  }, 120_000);

  it("a capacity outage (Workers AI 3040) leaves chunks stale: no split storm, no fallback or truncated vectors", async () => {
    const v = freshVault("ecap");
    expect((await op(v, "")).status).toBe(200);
    const content = longNote(400, 12);
    const note = await createNote(v, { content, path: "cap/n" });
    const chunks = chunkNoteContent(content).filter((c) => c.text.trim()).map((c) => capEmbedText(c.text));
    expect(chunks.length).toBeGreaterThan(1);

    // The real provider over a binding that is out of capacity for its first
    // few calls, with Workers AI's documented 3040 message, then recovers.
    const accepted: string[][] = [];
    let calls = 0;
    const ai = {
      async run(_model: string, inputs: { text: string[] }) {
        calls++;
        if (calls <= 6) throw new Error("3040: Capacity temporarily exceeded, please try again.");
        accepted.push(inputs.text);
        return { data: inputs.text.map(() => [1, 0, 0]) };
      },
    };
    const provider = new WorkersAiEmbeddingProvider(ai);

    // One wake during the outage (this note and the welcome seed fit one planned
    // call): one call, nothing stored, the chunks stay pending.
    await runInDurableObject<DurableObject, void>(doStub(v), async (inst: any) => {
      inst.__setTestEmbeddingProvider(provider);
      await inst.alarm();
    });
    expect(calls).toBe(1);
    expect(await vectorCount(v, note.id)).toBe(0);

    // Later wakes, once capacity is back: every vector stands for its whole chunk.
    let pending = -1;
    for (let i = 0; i < 25 && pending !== 0; i++) {
      await runInDurableObject<DurableObject, void>(doStub(v), async (inst: any) => {
        inst.__setTestEmbeddingProvider(provider);
        await inst.alarm();
        pending = getNotesPendingEmbedding(inst.store.db, provider.model, 1000).length;
      });
    }
    expect(pending).toBe(0);
    const sent = accepted.flat();
    expect(sent).not.toContain(EMBED_FALLBACK_TEXT);
    for (const c of chunks) {
      // The whole chunk was embedded, never a halved prefix standing in for it.
      expect(sent).toContain(c);
      expect(sent.filter((t) => t !== c && c.startsWith(t)).map((t) => t.length)).toEqual([]);
    }
    expect(await vectorCount(v, note.id)).toBe(chunks.length);
  }, 120_000);
  it("a too-long input whose message carries a number like 3040 is still rejected, not retried forever", async () => {
    // Second-review finding on the capacity fix: matching a bare `3040` (or
    // "capacity"/"try again") anywhere in the message took a real too-long
    // answer with that token count for an outage, so the chunk stayed stale
    // and was retried on every wake.
    for (const msg of [
      "input exceeded the model context window (3040 > 512 tokens)",
      "input too long: 3036 tokens, please try again with a shorter input",
    ]) {
      const provider = new WorkersAiEmbeddingProvider({
        run: async () => {
          throw new Error(msg);
        },
      } as any);
      const err = await provider.embed({ texts: ["x"] } as EmbedInput).catch((e) => e);
      expect(err, msg).toBeInstanceOf(EmbeddingError);
      expect((err as EmbeddingError).code, msg).toBe("input_rejected");
    }
  });
});
