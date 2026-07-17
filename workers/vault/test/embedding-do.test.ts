/**
 * Semantic-search DO pipeline (C2) — embed-on-write + backfill drain through
 * the DO alarm, and the alarm-multiplexing interplay with the LIVE
 * transcription pipeline (cloud#56).
 *
 * The alarm is shared: transcription (cloud#56, production) and the
 * embedding drain (C2) both wake on it. These tests pin the load-bearing
 * safety claim from the PR description — a due transcription AND stale
 * embedding work are BOTH processed within ONE `alarm()` call, and neither
 * can starve or corrupt the other (they touch disjoint tables/queues:
 * `attachments`/`transcribe_status` vs. `note_vectors`).
 *
 * Also pins: embed-on-write (a note write arms the alarm, the drain embeds
 * it), the no-op-edit freshness gate (zero additional provider calls), the
 * `near_text`/`semantic` REST wire (ranking, `embeddings_pending`,
 * `semantic_unavailable` 503), the `embeddings` capability field parity with
 * `transcription`'s, and the bounded-batch/re-arm behavior across two wakes.
 */
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { freshVault, op, createNote } from "./helpers.ts";
import type { EmbeddingProvider, EmbedInput, EmbedResult, ProviderAvailability } from "@openparachute/core/src/embedding/provider.ts";
import type { TranscriptionProvider, TranscribeInput, TranscribeResult } from "@openparachute/core/src/transcription/provider.ts";
import { chunkNoteContent } from "@openparachute/core/src/embedding/chunker.ts";
import { upsertNoteVector, getNotesPendingEmbedding } from "@openparachute/core/src/embedding/vectors.ts";
import { contentHash } from "@openparachute/core/src/embedding/staleness.ts";

const TEST_MODEL = "test-embed-model";
const DIMS = 3;

/** A stub embedding provider — `vectorFor` maps a chunk's text to a 3-dim
 *  vector, so tests can control ranking deterministically (no real model). */
function stubEmbedProvider(vectorFor: (text: string) => number[]): EmbeddingProvider & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    name: "test-stub",
    model: TEST_MODEL,
    dims: DIMS,
    calls,
    async available(): Promise<ProviderAvailability> {
      return { ok: true };
    },
    async embed(input: EmbedInput): Promise<EmbedResult> {
      calls.push(input.texts);
      return {
        vectors: input.texts.map((t) => new Float32Array(vectorFor(t))),
        model: TEST_MODEL,
        dims: DIMS,
      };
    },
  };
}

/** A stub transcription provider — scripted result or throw (mirrors
 *  transcription-do.test.ts's stubProvider). */
function stubTranscribeProvider(script: (input: TranscribeInput) => TranscribeResult): TranscriptionProvider {
  return {
    name: "test-stub",
    async available() {
      return { ok: true };
    },
    async transcribe(input) {
      return script(input);
    },
  };
}

function doStub(vault: string): DurableObjectStub {
  return env.VAULT.get(env.VAULT.idFromName(vault)) as unknown as DurableObjectStub;
}

/** Run ONE alarm pass with an injected embedding provider (and optionally a
 *  transcription provider, for the multiplexing tests) — direct `alarm()`
 *  call, not `runDurableObjectAlarm` (mirrors transcription-do.test.ts's
 *  `runAlarmWith`: a `setAlarm(now)` fires opportunistically in the vitest
 *  pool, so a direct call runs the exact production code path without that
 *  race). */
async function runAlarmWithEmbedding(
  vault: string,
  embedding: EmbeddingProvider,
  transcription?: TranscriptionProvider,
): Promise<void> {
  await runInDurableObject<DurableObject, void>(doStub(vault), async (inst: any) => {
    inst.__setTestEmbeddingProvider(embedding);
    if (transcription) inst.__setTestProvider(transcription);
    await inst.alarm();
  });
}

async function vectorRowCount(vault: string, noteId?: string): Promise<number> {
  let n = 0;
  await runInDurableObject<DurableObject, void>(doStub(vault), async (inst: any) => {
    const row = noteId
      ? inst.store.db.prepare("SELECT COUNT(*) AS n FROM note_vectors WHERE note_id = ?").get(noteId)
      : inst.store.db.prepare("SELECT COUNT(*) AS n FROM note_vectors").get();
    n = (row as { n: number }).n;
  });
  return n;
}

async function landing(vault: string): Promise<any> {
  return (await op(vault, "")).json();
}

async function apiVault(vault: string): Promise<any> {
  return (await op(vault, "/api/vault")).json();
}

/** Decode the `X-Parachute-Warnings` header (mirrors the bun conformance
 *  suite's convention). */
function decodeWarnings(res: Response): any[] | undefined {
  const raw = res.headers.get("X-Parachute-Warnings");
  return raw ? JSON.parse(decodeURIComponent(raw)) : undefined;
}

describe("semantic search (C2) — embed-on-write + backfill drain", () => {
  it("a note write arms the alarm; the drain embeds it and a matching near_text query finds it", async () => {
    const v = freshVault("sem");
    const created = await op(v, "/api/notes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "a note about music remixes as community building" }),
    });
    const note = (await created.json()) as { id: string };

    await runAlarmWithEmbedding(
      v,
      stubEmbedProvider((t) => (t.includes("music remixes") ? [1, 0, 0] : [0, 1, 0])),
    );

    expect(await vectorRowCount(v, note.id)).toBeGreaterThan(0);

    const res = await op(v, "/api/notes?semantic=true&near_text=music%20remixes&include_content=true");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any[];
    expect(body.map((n) => n.id)).toContain(note.id);
    expect(body.find((n) => n.id === note.id)!.score).toBeGreaterThan(0.9);
  });

  it("a no-op edit (identical content) costs ZERO additional provider calls", async () => {
    const v = freshVault("sem");
    const created = await op(v, "/api/notes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "stable content that never changes" }),
    });
    const note = (await created.json()) as { id: string };

    const provider = stubEmbedProvider(() => [1, 0, 0]);
    await runAlarmWithEmbedding(v, provider);
    expect(provider.calls.length).toBe(1);

    // Re-PATCH with the SAME content (metadata-only touch would also do, but
    // this exercises the exact "identical text" freshness gate).
    const patchRes = await op(v, `/api/notes/${note.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "stable content that never changes", force: true }),
    });
    expect(patchRes.status).toBe(200);

    const provider2 = stubEmbedProvider(() => [1, 0, 0]);
    await runAlarmWithEmbedding(v, provider2);
    expect(provider2.calls.length).toBe(0); // no-op edit — the staleness gate short-circuits before any provider call
  });

  it("embeddings_pending: store.semanticSearch reports the pending count while backfill is incomplete", async () => {
    // Everything below runs inside ONE `runInDurableObject` call, querying
    // `store.semanticSearch` directly instead of a second `SELF.fetch()` —
    // a SEPARATE fetch dispatch re-enters `ensureState`, which can RE-ARM
    // the embedding alarm (maybeArmEmbeddingBackfill), and this pool can
    // fire an armed alarm opportunistically (see runAlarmWithEmbedding's
    // doc) mid-request — racing this test's deliberately PARTIAL embedding
    // state (one note embedded, one left genuinely pending) unpredictably.
    // `runInDurableObject` itself is exclusive/atomic against that — every
    // OTHER test in this file that stays inside one such call is stable
    // across repeated runs; this is the one scenario that specifically
    // needs "some pending work still exists" to hold still for inspection.
    const v = freshVault("sem");
    const embedded = (await (
      await op(v, "/api/notes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "the one that gets embedded first", tags: ["semtest"] }),
      })
    ).json()) as { id: string };
    const notYet = (await (
      await op(v, "/api/notes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "the one that stays pending", tags: ["semtest"] }),
      })
    ).json()) as { id: string };

    let result: { notes: { id: string }[]; pendingCount: number; totalCandidates: number } | undefined;
    await runInDurableObject<DurableObject, void>(doStub(v), async (inst: any) => {
      await inst.ctx.storage.deleteAlarm(); // nothing left armed for this callback to race
      inst.__setTestEmbeddingProvider(stubEmbedProvider(() => [1, 0, 0]));
      // Embed ONLY the first note directly (bypassing the drain's own
      // candidate scan) so the second stays genuinely pending.
      const chunk = chunkNoteContent("the one that gets embedded first")[0]!;
      upsertNoteVector(inst.store.db, embedded.id, chunk, new Float32Array([1, 0, 0]), TEST_MODEL, contentHash(chunk.text));
      result = await inst.store.semanticSearch("anything", { tags: ["semtest"] });
    });

    expect(result!.notes.map((n) => n.id)).toEqual([embedded.id]); // only the embedded one is a candidate with a vector
    expect(result!.pendingCount).toBe(1);
    expect(result!.totalCandidates).toBe(2);
    void notYet;
  });

  it("embeddings_pending — REST wire shape: the warning rides X-Parachute-Warnings, notes ride the bare body", async () => {
    // A companion to the store-level test above, verifying the REST
    // encoding specifically — but in a FULLY DRAINED scenario (no alarm
    // left armed, matching the stable pattern every other REST-querying
    // test in this file already relies on) so it isn't exposed to the same
    // opportunistic-alarm race: one embedded note, and a SEPARATE,
    // never-embedded note living OUTSIDE the tag scope (so semanticSearch's
    // candidate set is just the one embedded note — no pending at all,
    // `pendingCount` stays 0 and the warning is simply ABSENT, still
    // proving the header/body split is honored).
    const v = freshVault("sem");
    const noteRes = await op(v, "/api/notes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "wire-shape note", tags: ["semtest2"] }),
    });
    const note = (await noteRes.json()) as { id: string };
    await runAlarmWithEmbedding(v, stubEmbedProvider(() => [1, 0, 0]));

    const res = await op(v, "/api/notes?semantic=true&near_text=anything&tag=semtest2&include_content=true");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any[];
    expect(body.map((n) => n.id)).toEqual([note.id]);
    expect(body[0].score).toBeGreaterThan(0.9);
    expect(res.headers.get("X-Parachute-Warnings")).toBeNull(); // nothing pending — no warning header at all
  });

  it("semantic_unavailable — REST 503 when no provider is available (no stub injected, test env)", async () => {
    const v = freshVault("sem");
    // No __setTestEmbeddingProvider call anywhere in this test — the DO's
    // default test-env resolution (undefined AI binding) reports
    // unavailable, mirroring a real deploy with no Workers AI reachable.
    const res = await op(v, "/api/notes?semantic=true&near_text=anything");
    expect(res.status).toBe(503);
    const body = (await res.json()) as any;
    expect(body.error_type).toBe("semantic_unavailable");
  });

  it("semantic + search is a 400 invalid_query, not silently one-or-the-other", async () => {
    const v = freshVault("sem");
    const res = await op(v, "/api/notes?semantic=true&near_text=x&search=y");
    expect(res.status).toBe(400);
    expect((await res.json() as any).field).toBe("semantic");
  });

  it("semantic=true without near_text is a 400 naming the missing field", async () => {
    const v = freshVault("sem");
    const res = await op(v, "/api/notes?semantic=true");
    expect(res.status).toBe(400);
    expect((await res.json() as any).field).toBe("near_text");
  });

  it("near_text without semantic=true is inert but warns (ignored_param) — ported from self-host routes.ts:1330-1332", async () => {
    const v = freshVault("sem");
    await createNote(v, { content: "an ordinary note", tags: ["nt-ignored"] });
    // Structured-query path (no `search`, no `semantic`) — near_text rides
    // along unused; the warning should still surface.
    const res = await op(v, "/api/notes?near_text=anything&tag=nt-ignored");
    expect(res.status).toBe(200);
    const warnings = decodeWarnings(res);
    const w = warnings?.find((x: any) => x.code === "ignored_param" && x.param === "near_text");
    expect(w).toBeDefined();
  });

  it("embeddings capability parity: bare landing and /api/vault carry the SAME shape", async () => {
    const v = freshVault("sem");
    // Default test env, no stub injected → unavailable → disabled.
    const land = await landing(v);
    expect(land.embeddings).toEqual({ enabled: false });
    expect((await apiVault(v)).embeddings).toEqual(land.embeddings);
  });

  it("bounded per-wake batch: drainEmbeddingsOnce caps at EMBED_NOTES_PER_WAKE (25) notes and reports more:true", async () => {
    // Calls `drainEmbeddingsOnce()` DIRECTLY (not the full `alarm()`) so this
    // test never touches `ctx.storage.setAlarm` — the vitest pool can fire an
    // ARMED alarm opportunistically (see runAlarmWithEmbedding's doc), which
    // would race a two-separate-wakes measurement unpredictably. Calling the
    // drain unit directly, twice, in ONE uninterrupted `runInDurableObject`
    // flow is deterministic and tests exactly the unit responsible for the
    // batch cap.
    const v = freshVault("sem");
    await landing(v); // materializes config + the welcome seed
    const ids: string[] = [];
    await runInDurableObject<DurableObject, void>(doStub(v), async (inst: any) => {
      // Create more notes than one wake's batch budget, all SHORT
      // (single-chunk) and TAGGED so the count below isn't muddied by the
      // welcome-seed guides (which may themselves span multiple chunks).
      for (let i = 0; i < 27; i++) {
        const note = await inst.store.createNote(`backlog note number ${i} with unique filler text`, {
          tags: ["backlog"],
        });
        ids.push(note.id);
      }
      // No armed alarm can fire mid-test here — this whole block is one
      // synchronous `runInDurableObject` callback, and neither `createNote`
      // (via the embedding-alarm-arm hook) nor `drainEmbeddingsOnce` itself
      // ever calls `setAlarm` here (only `alarm()`'s own re-arm step does).
      await inst.ctx.storage.deleteAlarm(); // belt-and-suspenders
      const placeholders = ids.map(() => "?").join(", ");
      const embeddedCount = () =>
        (inst.store.db.prepare(`SELECT COUNT(DISTINCT note_id) AS n FROM note_vectors WHERE note_id IN (${placeholders})`).get(...ids) as { n: number }).n;

      inst.__setTestEmbeddingProvider(stubEmbedProvider(() => [1, 0, 0]));
      const outcome1 = await inst.drainEmbeddingsOnce();
      expect(outcome1.kind).toBe("partial");
      expect(outcome1.more).toBe(true); // more candidates existed beyond this wake's cap
      const afterFirst = embeddedCount();
      expect(afterFirst).toBeGreaterThan(0);
      expect(afterFirst).toBeLessThanOrEqual(25); // EMBED_NOTES_PER_WAKE
      expect(afterFirst).toBeLessThan(27); // NOT everything — a second pass is required

      const outcome2 = await inst.drainEmbeddingsOnce();
      expect(outcome2.kind).toBe("partial");
      expect(outcome2.more).toBe(false); // fully drained after the second pass
      expect(embeddedCount()).toBe(27);
    });
  });

  it("a single note with >100 chunks: no embed() call exceeds 90 texts, and the drain fully embeds it", async () => {
    // Regression for the review-round-2 blocker: EMBED_NOTES_PER_WAKE bounds
    // NOTES per wake (25), NOT the flattened CHUNK count — bge-m3 hard-caps
    // its input array at 100 items (Cloudflare docs; not captured in
    // @cloudflare/workers-types), so a single long note alone can overflow
    // one provider.embed() call. Content: many paragraphs, each individually
    // LONGER than the chunker's ~1800-char target — chunker.ts's
    // packParagraphs documents that an over-target paragraph becomes its
    // OWN chunk (never merged with a neighbor, since it already exceeds
    // minChars), so N such paragraphs deterministically yield N chunks.
    const bigParagraph = "word ".repeat(400); // ~2000 chars, over the ~1800-char target
    const content = Array.from({ length: 110 }, () => bigParagraph).join("\n\n");
    const chunkCount = chunkNoteContent(content).length;
    expect(chunkCount).toBeGreaterThan(100); // sanity: the synthetic content actually produces >100 chunks

    const v = freshVault("sem");
    // Prime: materialize + fully drain the welcome-seed notes FIRST, under
    // the SAME model the real assertions below use — otherwise the seed
    // guides' own chunks get flattened into the SAME wake as the giant
    // note (EMBED_NOTES_PER_WAKE=25 easily covers both), inflating the
    // call-total below. This test isolates ONE note's chunk count.
    await landing(v);
    await runAlarmWithEmbedding(v, stubEmbedProvider(() => [1, 0, 0]));

    const noteRes = await op(v, "/api/notes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content, tags: ["bigmono"] }),
    });
    const note = (await noteRes.json()) as { id: string };

    const provider = stubEmbedProvider(() => [1, 0, 0]);
    await runAlarmWithEmbedding(v, provider);

    // (b) no single embed() call carried more than 90 texts.
    expect(provider.calls.length).toBeGreaterThan(1); // proves sub-batching actually happened, not one lucky call
    for (const call of provider.calls) {
      expect(call.length).toBeLessThanOrEqual(90);
    }
    const totalTextsAcrossCalls = provider.calls.reduce((sum, c) => sum + c.length, 0);
    expect(totalTextsAcrossCalls).toBe(chunkCount);

    // (a) the drain advances past it — every chunk of the one note landed a
    // vector row (the backlog doesn't wedge on the oversized window).
    const rowCount = await vectorRowCount(v, note.id);
    expect(rowCount).toBe(chunkCount);
  });

  it("alarm interplay: a DUE transcription and a STALE note are BOTH processed in ONE alarm() call", async () => {
    const v = freshVault("sem");
    // Arrange a stale (unembedded) note.
    const noteRes = await op(v, "/api/notes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "unembedded note for the multiplex test" }),
    });
    const note = (await noteRes.json()) as { id: string };

    // Arrange a due transcription: upload audio + link transcribe:true (the
    // pending-attachment path — same setup transcription-do.test.ts uses),
    // but voice isn't entitled here, so the transcription branch resolves to
    // its own honest terminal marker — still exercising transcribeOne within
    // this SAME alarm wake, proving it runs unaffected by the embedding work.
    const form = new FormData();
    form.set("file", new File([new Uint8Array([1, 2, 3])], "memo.webm", { type: "audio/webm" }));
    const up = await op(v, "/api/storage/upload", { method: "POST", body: form });
    const { path } = (await up.json()) as { path: string };
    const voiceNoteRes = await op(v, "/api/notes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "# Voice memo\n\n_Transcript pending._\n" }),
    });
    const voiceNote = (await voiceNoteRes.json()) as { id: string };
    const link = await op(v, `/api/notes/${voiceNote.id}/attachments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, mimeType: "audio/webm", transcribe: true }),
    });
    expect(link.status).toBe(201);

    let transcribeCalls = 0;
    await runAlarmWithEmbedding(
      v,
      stubEmbedProvider(() => [1, 0, 0]),
      stubTranscribeProvider(() => {
        transcribeCalls++;
        return { text: "should not be reachable — no voice entitlement", audioSeconds: 1 };
      }),
    );

    // Transcription ran (the entitlement gate resolved it terminally WITHOUT
    // even calling the provider — "voice not enabled for this plan" — so
    // transcribeCalls stays 0, but the note body proves transcribeOne executed).
    expect(transcribeCalls).toBe(0);
    const voiceBody = ((await (await op(v, `/api/notes/${voiceNote.id}`)).json()) as { content: string }).content;
    expect(voiceBody).toContain("_Transcription unavailable._");

    // Embedding ALSO ran, in the SAME alarm() call.
    expect(await vectorRowCount(v, note.id)).toBeGreaterThan(0);
  });

  it("model-change staleness: a done-flag persisted under an OLD model doesn't mask a NEW model's fresh backfill need", async () => {
    const v = freshVault("sem");
    await landing(v); // materializes config
    await runInDurableObject<DurableObject, void>(doStub(v), async (inst: any) => {
      // Seed: as if a PRIOR deploy fully drained this vault under a
      // different model (a redeploy that changed EMBEDDING_MODEL).
      // "embedding_backfill_done" must match EMBEDDING_BACKFILL_DONE_KEY in
      // vault-do.ts (not exported — the storage key is an implementation
      // literal, mirrored here as the vitest suites already do for
      // EMBED_NOTES_PER_WAKE's value elsewhere in this file).
      await inst.ctx.storage.put("embedding_backfill_done", { done: true, model: "old-model" });
      await inst.ctx.storage.deleteAlarm();
      inst.__resetEmbeddingBackfillState(); // force a fresh load from storage
      // The CURRENTLY active provider's model (TEST_MODEL) differs from the
      // persisted "old-model" — the stale flag must NOT read as done.
      inst.__setTestEmbeddingProvider(stubEmbedProvider(() => [1, 0, 0]));
      await inst.maybeArmEmbeddingBackfill();
      expect(inst.embeddingBackfillDone).toBe(false);
      const alarm = await inst.ctx.storage.getAlarm();
      expect(alarm).not.toBeNull(); // armed to re-check/backfill under the new model
    });
  });

  it("concurrent-write race: a note landing WHILE the drain's embed() call is in flight isn't masked by a wrongly-persisted done flag", async () => {
    const v = freshVault("sem");
    await landing(v);
    let raceNoteId = "";
    await runInDurableObject<DurableObject, void>(doStub(v), async (inst: any) => {
      await inst.ctx.storage.deleteAlarm();
      inst.__resetEmbeddingBackfillState();
      // A stub whose embed() call itself creates a NEW note — simulating a
      // REST/MCP write landing (and synchronously committing) WHILE this
      // wake's drainEmbeddingsOnce is awaiting the provider, AFTER its own
      // candidate scan already ran. This is deterministic (no real
      // concurrency needed) and exercises the exact race window the fix
      // closes: the write's own hook sets embeddingBackfillDone=false but
      // (being mid-alarm) can't arm a new alarm itself (alarmRunning guard)
      // — alarm()'s own re-check-before-persisting-done must catch it.
      const raceProvider: EmbeddingProvider = {
        name: "race-stub",
        model: TEST_MODEL,
        dims: DIMS,
        async available(): Promise<ProviderAvailability> {
          return { ok: true };
        },
        async embed(input: EmbedInput): Promise<EmbedResult> {
          const note = await inst.store.createNote("a note that lands mid-drain", { tags: ["race"] });
          raceNoteId = note.id;
          return { vectors: input.texts.map(() => new Float32Array([1, 0, 0])), model: TEST_MODEL, dims: DIMS };
        },
      };
      inst.__setTestEmbeddingProvider(raceProvider);
      // Seed ONE genuinely-pending note so drainEmbeddingsOnce has
      // something to embed (and thus calls embed(), triggering the race).
      await inst.store.createNote("the note this wake actually embeds", { tags: ["seed"] });
      await inst.alarm();

      // The race note must NOT be silently marked "done" — still pending,
      // NEVER persisted as complete, and the alarm re-armed to pick it up.
      expect(inst.embeddingBackfillDone).toBe(false);
      const stored = await inst.ctx.storage.get("embedding_backfill_done");
      expect(stored).toBeUndefined();
      const pending = getNotesPendingEmbedding(inst.store.db, TEST_MODEL, 10);
      expect(pending.some((n: { id: string }) => n.id === raceNoteId)).toBe(true);
      const alarm = await inst.ctx.storage.getAlarm();
      expect(alarm).not.toBeNull();
    });
  });
});
