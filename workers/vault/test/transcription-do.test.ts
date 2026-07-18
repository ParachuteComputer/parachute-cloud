/**
 * Voice-transcription DO pipeline (cloud#56) — the eternal-spinner fix,
 * end-to-end through the DO alarm.
 *
 * The bug: a `transcribe:true` attachment link against a cloud vault used to
 * no-op, so the note kept `_Transcript pending._` and Notes' "Transcribing…"
 * chip spun forever. Here the flag arms the DO alarm, which drains pending
 * attachments through an INJECTED stub provider (no live Workers AI binding)
 * and surgically resolves the note to text or a terminal marker — proving the
 * spinner always terminates.
 *
 * Pins: plan gating (free = disabled = honest unavailable; voice = enabled +
 * metered), the monthly soft cap, placeholder replacement, duration metering,
 * and `until_transcribed` retention (R2 audio dropped + storage meter freed).
 */
import { SELF, env, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { FIRST_PARTY_CLIENT_ID } from "../src/auth.ts";
import { base, freshVault, mintToken, op, OP } from "./helpers.ts";
import { r2Key } from "../src/rest/notes.ts";
import type { TranscriptionProvider, TranscribeInput, TranscribeResult } from "@openparachute/core/src/transcription/provider.ts";
import { TranscriptionError } from "@openparachute/core/src/transcription/provider.ts";
import { MAX_TRANSCRIBE_BYTES } from "../src/transcription/workers-ai.ts";
import type { TextGeneratorLike } from "../src/transcription/cleanup.ts";

/** First-party admin token — exactly what identity's plan push mints. */
function firstPartyToken(vault: string): Promise<string> {
  return mintToken({ vault, scopes: `vault:${vault}:admin`, vaultScope: [vault], clientId: FIRST_PARTY_CLIENT_ID });
}

/** Push the voice entitlement the way the Identity Worker's plan apply does. */
async function pushEntitlement(vault: string, enabled: boolean, minutesLimit: number): Promise<void> {
  const res = await SELF.fetch(`${base(vault)}/api/internal/config`, {
    method: "PUT",
    headers: { authorization: `Bearer ${await firstPartyToken(vault)}`, "content-type": "application/json" },
    body: JSON.stringify({ transcription: { enabled, minutes_limit: minutesLimit } }),
  });
  if (res.status !== 200) throw new Error(`pushEntitlement → ${res.status}: ${await res.text()}`);
}

/** Upload audio bytes; returns the vault-relative storage path. */
async function uploadAudio(vault: string, bytes: Uint8Array): Promise<string> {
  const form = new FormData();
  form.set("file", new File([bytes], "memo.webm", { type: "audio/webm" }));
  const up = await op(vault, "/api/storage/upload", { method: "POST", body: form });
  if (up.status !== 201) throw new Error(`uploadAudio → ${up.status}: ${await up.text()}`);
  return ((await up.json()) as { path: string }).path;
}

/** A voice-memo note (placeholder body) + its uploaded audio, linked with
 *  transcribe:true (which stamps pending + arms the alarm). Returns ids. */
async function setupVoiceNote(
  vault: string,
  audioBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
): Promise<{ noteId: string; audioPath: string }> {
  const path = await uploadAudio(vault, audioBytes);
  // Body mirrors notes-ui memoNoteContent (parachute-surface): the embed is a
  // BARE filename, never the slashed storage path — the pipeline reads the
  // attachment's R2 path, not the embed.
  const noteRes = await op(vault, "/api/notes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: `# 🎙️ Voice memo\n\n_Transcript pending._\n\n![[memo.webm]]\n` }),
  });
  const note = (await noteRes.json()) as { id: string };
  const link = await op(vault, `/api/notes/${note.id}/attachments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, mimeType: "audio/webm", transcribe: true }),
  });
  if (link.status !== 201) throw new Error(`link → ${link.status}: ${await link.text()}`);
  return { noteId: note.id, audioPath: path };
}

/** A stub provider — returns a scripted result, or throws a scripted error. */
function stubProvider(script: (input: TranscribeInput) => TranscribeResult): TranscriptionProvider {
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

/** The vault's DO stub (base-typed to avoid deep VaultDO type instantiation). */
function doStub(vault: string): DurableObjectStub {
  return env.VAULT.get(env.VAULT.idFromName(vault)) as unknown as DurableObjectStub;
}

/**
 * Inject a stub provider and run ONE alarm pass deterministically through
 * `runDurableObjectAlarm` (cloud#171 de-flake) — NOT a direct `inst.alarm()`
 * call. The setup calls above this (uploadAudio, the note POST, the
 * attachment link) each arm the DO's real alarm via `ctx.storage.setAlarm`;
 * under FULL-suite `vitest-pool-workers` concurrency the pool can deliver
 * that armed alarm on its OWN, opportunistically, genuinely CONCURRENTLY
 * with a direct method call on the same live instance (`runInDurableObject`
 * bypasses the runtime's own alarm-dispatch bookkeeping entirely, so a
 * direct `inst.alarm()` call is a SEPARATE path into the same method,
 * raceable against the runtime-delivered one) — two overlapping `alarm()`
 * invocations both reading `transcribe_status: "pending"` before either
 * writes back, double-metering the one audio sample (cloud#171: 596 vs 598
 * minutes). `runDurableObjectAlarm(stub)` is the harness's OWN sanctioned
 * mechanism for triggering a DO's alarm — "immediately runs AND REMOVES" the
 * scheduled alarm as one operation, the same single-flight delivery the
 * runtime's opportunistic firing itself uses, so driving it explicitly here
 * doesn't open a SECOND competing path the way a direct call does. Setting
 * the stub and a FRESH `setAlarm(now)` immediately before calling it
 * (re-arming defensively, in case an earlier opportunistic delivery already
 * consumed whatever setup armed) keeps this deterministic even if a prior
 * wake already ran with stale state. (`VaultDO.alarm()` ALSO gained its own
 * synchronous reentrancy guard as defense in depth — see `alarmRunning`'s doc
 * in vault-do.ts.)
 */
async function runAlarmWith(vault: string, provider: TranscriptionProvider): Promise<void> {
  await runInDurableObject<DurableObject, void>(doStub(vault), async (inst: any) => {
    inst.__setTestProvider(provider);
    await inst.ctx.storage.setAlarm(Date.now());
  });
  await runDurableObjectAlarm(doStub(vault));
}

/** A stub cleanup text generator — returns a scripted `{ response }` (or throws). */
function stubCleanup(script: (raw: string) => { response?: unknown }): TextGeneratorLike {
  return {
    async run(_model, inputs) {
      const raw = inputs.messages.find((m) => m.role === "user")?.content ?? "";
      return script(raw) as { response?: unknown } & Record<string, unknown>;
    },
  };
}

/** Run one alarm pass with BOTH a stub provider and a stub cleanup generator
 *  injected (the cleanup pass otherwise soft-fails to raw under the test env).
 *  Same opportunistic-firing race as `runAlarmWith` (cloud#171), same fix
 *  (drive via `runDurableObjectAlarm`, not a direct `inst.alarm()` call). */
async function runAlarmWithCleanup(
  vault: string,
  provider: TranscriptionProvider,
  cleanup: TextGeneratorLike,
): Promise<void> {
  await runInDurableObject<DurableObject, void>(doStub(vault), async (inst: any) => {
    inst.__setTestProvider(provider);
    inst.__setTestCleanup(cleanup);
    await inst.ctx.storage.setAlarm(Date.now());
  });
  await runDurableObjectAlarm(doStub(vault));
}

/** Read a note's stored metadata straight from the DO store (bypasses REST
 *  metadata filtering) so we can assert `raw_transcript` is preserved. */
async function noteMetaViaStore(vault: string, id: string): Promise<Record<string, unknown>> {
  let meta: Record<string, unknown> = {};
  await runInDurableObject<DurableObject, void>(doStub(vault), async (inst: any) => {
    const note = await inst.store.getNote(id);
    meta = (note?.metadata as Record<string, unknown>) ?? {};
  });
  return meta;
}

async function noteBody(vault: string, id: string): Promise<string> {
  const res = await op(vault, `/api/notes/${id}`);
  return ((await res.json()) as { content: string }).content;
}

async function attachments(vault: string, noteId: string): Promise<any[]> {
  return (await (await op(vault, `/api/notes/${noteId}/attachments`)).json()) as any[];
}

/** Clear a pending attachment's backoff so the next alarm treats it as due
 *  (fast-forwards past the exponential backoff the retry path sets). */
async function clearBackoff(vault: string, attId: string): Promise<void> {
  await runInDurableObject<DurableObject, void>(doStub(vault), async (inst: any) => {
    const att = await inst.store.getAttachment(attId);
    const meta = { ...(att.metadata ?? {}) };
    delete meta.transcribe_backoff_until;
    await inst.store.setAttachmentMetadata(attId, meta);
  });
}

async function landing(vault: string): Promise<any> {
  return (await op(vault, "")).json();
}

describe("voice transcription pipeline (cloud#56)", () => {
  // Scheduling-on-flag is proven by contrast: every transcribe:true test below
  // lands a transcript (so the alarm WAS armed + ran for TRANSCRIPTION), while
  // the final transcribe:false test asserts the attachment never carries
  // `transcribe_status` at all — a precise, transcription-specific check (an
  // alarm may still be armed for the embedding drain, C2, independent of
  // transcription — see that test's note).

  it("voice tier: transcribes, replaces the placeholder, meters minutes, drops the spinner", async () => {
    const v = freshVault("tx");
    await pushEntitlement(v, true, 600);
    const { noteId } = await setupVoiceNote(v);

    await runAlarmWith(v, stubProvider(() => ({ text: "hello from whisper", audioSeconds: 120 })));

    const body = await noteBody(v, noteId);
    expect(body).toContain("hello from whisper");
    expect(body).not.toContain("_Transcript pending._"); // spinner is GONE
    // Metered by the audio duration → 120s = 2 minutes; 600 − 2 = 598 left.
    const land = await landing(v);
    expect(land.transcription).toEqual({ enabled: true, minutes_remaining: 598 });
  });

  it("free (no entitlement): resolves to an honest 'unavailable' marker, never eternal pending", async () => {
    const v = freshVault("tx");
    // No entitlement pushed → disabled by default.
    const { noteId } = await setupVoiceNote(v);

    await runAlarmWith(v, stubProvider(() => ({ text: "should not be used", audioSeconds: 10 })));

    const body = await noteBody(v, noteId);
    expect(body).toContain("_Transcription unavailable._");
    expect(body).not.toContain("_Transcript pending._");
    expect((await landing(v)).transcription).toEqual({ enabled: false, minutes_remaining: 0 });
  });

  it("monthly soft cap: over-budget transcriptions get the limit marker, text is never blocked", async () => {
    const v = freshVault("tx");
    await pushEntitlement(v, true, 1); // 1-minute budget

    // First memo (2 min) is allowed through (cap stops NEW ones once over) and
    // pushes the meter to 2 minutes — over the 1-minute budget.
    const first = await setupVoiceNote(v);
    await runAlarmWith(v, stubProvider(() => ({ text: "first transcript", audioSeconds: 120 })));
    expect(await noteBody(v, first.noteId)).toContain("first transcript");
    expect((await landing(v)).transcription.minutes_remaining).toBe(0);

    // Second memo is refused at the cap — the limit marker, no provider call.
    const second = await setupVoiceNote(v);
    let called = false;
    await runAlarmWith(v, stubProvider(() => { called = true; return { text: "nope", audioSeconds: 1 }; }));
    const body = await noteBody(v, second.noteId);
    expect(body).toContain("Monthly voice limit reached");
    expect(body).not.toContain("_Transcript pending._");
    expect(called).toBe(false);
  });

  it("retriable failures back off (still pending, spinner honest), then go terminal after 3 attempts", async () => {
    const v = freshVault("tx");
    await pushEntitlement(v, true, 600);
    const { noteId } = await setupVoiceNote(v);
    // A plain Error is retriable (the worker contract): the worker backs off.
    const retriable = stubProvider(() => {
      throw new Error("transient upstream 503");
    });

    // Attempt 1 → still PENDING with a backoff, note still shows the spinner
    // (honest — it IS still being retried, not failed). No REST call happens
    // between `setupVoiceNote` (which arms the alarm) and `runAlarmWith`
    // (which cancels + drives it) — cloud#171: an intervening `SELF.fetch`
    // dispatch here (the old code fetched `attId` via a separate `GET
    // /attachments` before this point) gives the vitest pool's own
    // opportunistic alarm delivery an extra window to fire before our
    // controlled call takes over, racing it. `attId` is derived below from
    // the SAME response this call's own assertions already fetch, instead.
    await runAlarmWith(v, retriable);
    let att = (await attachments(v, noteId))[0];
    const attId = att.id;
    expect(att.metadata.transcribe_status).toBe("pending");
    expect(att.metadata.transcribe_attempts).toBe(1);
    expect(att.metadata.transcribe_backoff_until).toBeTruthy();
    expect(await noteBody(v, noteId)).toContain("_Transcript pending._");

    // Attempt 2 (past the backoff) → still pending, attempts=2.
    await clearBackoff(v, attId);
    await runAlarmWith(v, retriable);
    att = (await attachments(v, noteId))[0];
    expect(att.metadata.transcribe_status).toBe("pending");
    expect(att.metadata.transcribe_attempts).toBe(2);

    // Attempt 3 → exhausted → TERMINAL: failed + the unavailable marker.
    await clearBackoff(v, attId);
    await runAlarmWith(v, retriable);
    att = (await attachments(v, noteId))[0];
    expect(att.metadata.transcribe_status).toBe("failed");
    const body = await noteBody(v, noteId);
    expect(body).toContain("_Transcription unavailable._");
    expect(body).not.toContain("_Transcript pending._");
  });

  it("terminal provider failure writes the unavailable marker + fails the attachment", async () => {
    const v = freshVault("tx");
    await pushEntitlement(v, true, 600);
    const { noteId } = await setupVoiceNote(v);

    await runAlarmWith(v, stubProvider(() => {
      throw new TranscriptionError("bad audio", { code: "audio_too_long", retriable: false });
    }));

    const body = await noteBody(v, noteId);
    expect(body).toContain("_Transcription unavailable._");
    expect(body).not.toContain("_Transcript pending._");
    // Attachment recorded failed (not pending forever).
    const atts = (await (await op(v, `/api/notes/${noteId}/attachments`)).json()) as any[];
    expect(atts[0].metadata.transcribe_status).toBe("failed");
  });

  it("cloud#67: over-ceiling audio is HEAD-gated terminal BEFORE the R2 read — the provider never runs", async () => {
    // The uncatchable-OOM guard: an oversized file must fail on `head.size >
    // MAX_TRANSCRIBE_BYTES` before its bytes ever land in DO memory (the
    // base64 encode OOM tears the isolate down uncatchably — workers-ai.ts).
    const v = freshVault("tx");
    await pushEntitlement(v, true, 600);
    const { noteId, audioPath } = await setupVoiceNote(v);
    // Swap the stored object for one just over the ceiling, straight into R2
    // (skips a 25 MB multipart upload; the gate only reads head.size).
    await env.ATTACHMENTS.put(r2Key(v, audioPath), new Uint8Array(MAX_TRANSCRIBE_BYTES + 1));

    let providerCalls = 0;
    await runAlarmWith(
      v,
      stubProvider(() => {
        providerCalls++;
        return { text: "must never be reached" };
      }),
    );

    expect(providerCalls).toBe(0); // gated before the read, encode, and provider
    const body = await noteBody(v, noteId);
    expect(body).toContain("_Transcription unavailable._");
    expect(body).not.toContain("_Transcript pending._");
    const atts = (await (await op(v, `/api/notes/${noteId}/attachments`)).json()) as any[];
    expect(atts[0].metadata.transcribe_status).toBe("failed"); // terminal, not a retry loop
  });

  it("retention=until_transcribed drops the R2 audio + frees the storage meter on success", async () => {
    const v = freshVault("tx");
    await pushEntitlement(v, true, 600);
    // Set retention BEFORE the transcription.
    const patch = await op(v, "/api/vault", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ config: { audio_retention: "until_transcribed" } }),
    });
    expect(patch.status).toBe(200);

    const { noteId, audioPath } = await setupVoiceNote(v, new Uint8Array(1024).fill(7));
    // The audio object exists in R2 before transcription.
    expect(await env.ATTACHMENTS.head(r2Key(v, audioPath))).not.toBeNull();

    await runAlarmWith(v, stubProvider(() => ({ text: "kept the text", audioSeconds: 30 })));

    expect(await noteBody(v, noteId)).toContain("kept the text");
    // R2 audio is gone (retention), but the transcript survives on the note.
    expect(await env.ATTACHMENTS.head(r2Key(v, audioPath))).toBeNull();
  });

  it("cleanup (default ON): tidied text lands in the body; RAW preserved in metadata", async () => {
    const v = freshVault("tx");
    await pushEntitlement(v, true, 600);
    const { noteId } = await setupVoiceNote(v);

    const rawTranscript = "um I went to the uh store and it was fine";
    const cleanedView = "I went to the store and it was fine.";
    // whisper returns the raw; the cleanup model returns a faithful tidy → the
    // guard accepts it (only disfluencies dropped, punctuation/casing added).
    await runAlarmWithCleanup(
      v,
      stubProvider(() => ({ text: rawTranscript, audioSeconds: 60 })),
      stubCleanup(() => ({ response: cleanedView })),
    );

    const body = await noteBody(v, noteId);
    expect(body).toContain(cleanedView); // note CONTENT = the cleaned (readable) view
    expect(body).not.toContain("_Transcript pending._");
    expect(body).not.toContain(rawTranscript); // the raw filler-laden text is NOT in the body

    // RAW IS SACRED: preserved on the note metadata + the attachment.
    const nMeta = await noteMetaViaStore(v, noteId);
    expect(nMeta.raw_transcript).toBe(rawTranscript);
    const att = (await attachments(v, noteId))[0];
    expect(att.metadata.transcribe_cleaned).toBe(true);
    expect(att.metadata.raw_transcript).toBe(rawTranscript);
    expect(att.metadata.transcript).toBe(rawTranscript); // transcript field stays RAW
  });

  it("cleanup guard REJECTS a hallucination → RAW text is shown, raw preserved", async () => {
    const v = freshVault("tx");
    await pushEntitlement(v, true, 600);
    const { noteId } = await setupVoiceNote(v);

    const rawTranscript = "i really enjoy algorithms";
    // The cleanup model hallucinates a changed phrase — the guard MUST discard it.
    await runAlarmWithCleanup(
      v,
      stubProvider(() => ({ text: rawTranscript, audioSeconds: 30 })),
      stubCleanup(() => ({ response: "I really enjoy Al Gore's ideas." })),
    );

    const body = await noteBody(v, noteId);
    expect(body).toContain(rawTranscript); // the RAW is what's shown
    expect(body).not.toContain("Al Gore"); // the hallucination never reaches the note
    expect(body).not.toContain("_Transcript pending._");

    const nMeta = await noteMetaViaStore(v, noteId);
    expect(nMeta.raw_transcript).toBe(rawTranscript);
    const att = (await attachments(v, noteId))[0];
    expect(att.metadata.transcribe_cleaned).toBe(false);
  });

  it("cleanup soft-fail (model throws): RAW lands, note is never stuck", async () => {
    const v = freshVault("tx");
    await pushEntitlement(v, true, 600);
    const { noteId } = await setupVoiceNote(v);

    const rawTranscript = "the transcript must still land even if cleanup breaks";
    await runAlarmWithCleanup(
      v,
      stubProvider(() => ({ text: rawTranscript, audioSeconds: 45 })),
      stubCleanup(() => {
        throw new Error("cleanup model 500");
      }),
    );

    const body = await noteBody(v, noteId);
    expect(body).toContain(rawTranscript);
    expect(body).not.toContain("_Transcript pending._");
    const att = (await attachments(v, noteId))[0];
    expect(att.metadata.transcribe_status).toBe("done"); // resolved, not stuck
    expect(att.metadata.transcribe_cleaned).toBe(false);
    expect(att.metadata.raw_transcript).toBe(rawTranscript);
  });

  it("without an injected cleanup generator, the pipeline soft-fails to raw (unbound = default)", async () => {
    const v = freshVault("tx");
    await pushEntitlement(v, true, 600);
    const { noteId } = await setupVoiceNote(v);

    // The existing runAlarmWith injects NO cleanup gen → env.AI is unbound in
    // the test env → cleanup soft-fails → the raw whisper text lands unchanged.
    await runAlarmWith(v, stubProvider(() => ({ text: "plain whisper output here", audioSeconds: 12 })));

    expect(await noteBody(v, noteId)).toContain("plain whisper output here");
    const att = (await attachments(v, noteId))[0];
    expect(att.metadata.transcribe_cleaned).toBe(false);
    expect(att.metadata.raw_transcript).toBe("plain whisper output here");
  });

  it("transcribe:false attachments are plain data — never queued for TRANSCRIPTION", async () => {
    const v = freshVault("tx");
    const path = await uploadAudio(v, new Uint8Array([9, 9, 9]));
    const note = (await (await op(v, "/api/notes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "a doc with a file" }),
    })).json()) as { id: string };
    const link = await op(v, `/api/notes/${note.id}/attachments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, mimeType: "application/octet-stream" }),
    });
    expect(link.status).toBe(201);
    const attachment = (await link.json()) as { metadata?: Record<string, unknown> };
    // No transcribe_status at all — never stamped pending, contrast
    // setupVoiceNote's transcribe:true assertions elsewhere in this file.
    // NOTE (C2): this no longer means "no alarm was armed at all" — ANY note
    // write (this test's own POST /api/notes) now also arms the embedding
    // drain's alarm (semantic search MVP), independent of transcription; the
    // transcribe_status check below is the precise, transcription-specific
    // assertion this test actually cares about.
    expect(attachment.metadata?.transcribe_status).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Per-segment slots + retry endpoint (voice W2)
// ---------------------------------------------------------------------------

/** A multi-part voice-memo note: ONE note carrying a `_Transcript pending
 *  (part N)._` marker per segment, plus one audio attachment per segment linked
 *  with `segment_index` (0-based) + distinct audio bytes (byte = N, so a
 *  byte-keyed stub can return the right transcript for whichever part wakes
 *  first — race-robust regardless of completion order). */
async function setupSegmentedVoiceNote(
  vault: string,
  count = 3,
): Promise<{ noteId: string; attIds: string[] }> {
  const markers = Array.from({ length: count }, (_, i) => `_Transcript pending (part ${i + 1})._`);
  const content = `# 🎙️ Voice memo\n\n${markers.join("\n\n")}\n\n![[memo.webm]]\n`;
  const noteRes = await op(vault, "/api/notes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
  const note = (await noteRes.json()) as { id: string };
  const attIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const path = await uploadAudio(vault, new Uint8Array([i + 1])); // byte = part number N
    const link = await op(vault, `/api/notes/${note.id}/attachments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, mimeType: "audio/webm", transcribe: true, segment_index: i }),
    });
    if (link.status !== 201) throw new Error(`segment ${i} link → ${link.status}: ${await link.text()}`);
    attIds.push(((await link.json()) as { id: string }).id);
  }
  return { noteId: note.id, attIds };
}

/** A byte-keyed stub: returns "transcript for part <firstByte>" — so whichever
 *  segment the alarm happens to pick resolves to ITS OWN transcript (the byte we
 *  uploaded equals the part number N), making slot-targeting assertions
 *  independent of completion order + any opportunistic-alarm race. */
const bytePartStub = stubProvider((input: TranscribeInput) => ({
  text: `transcript for part ${input.audio[0] ?? 0}`,
  audioSeconds: 60,
}));

/** Push a pending attachment's backoff into the future so the next alarm skips
 *  it (only the un-backed-off segment is "due"), giving deterministic control
 *  over completion ORDER. */
async function setBackoffFuture(vault: string, attId: string): Promise<void> {
  await runInDurableObject<DurableObject, void>(doStub(vault), async (inst: any) => {
    const att = await inst.store.getAttachment(attId);
    const meta = { ...(att.metadata ?? {}) };
    meta.transcribe_backoff_until = new Date(Date.now() + 120_000).toISOString();
    await inst.store.setAttachmentMetadata(attId, meta);
  });
}

/**
 * Put a linked memo into a `failed` TERMINAL state exactly as the pipeline's
 * own `markTerminal` + `patchNoteBody` do — attachment `failed` (+ attempts
 * bookkeeping, optional non-retriable `errorCode`), the note body flipped to
 * the unavailable marker, `transcribe_stub` cleared. Doing it directly (rather
 * than through a throwing stub) leaves NO test provider on the warm instance,
 * so an opportunistic alarm wake can't re-run + re-dirty the row mid-test.
 */
async function forceFailedTerminal(
  vault: string,
  noteId: string,
  attId: string,
  opts: { errorCode?: string } = {},
): Promise<void> {
  await runInDurableObject<DurableObject, void>(doStub(vault), async (inst: any) => {
    const att = await inst.store.getAttachment(attId);
    await inst.store.setAttachmentMetadata(attId, {
      ...(att.metadata ?? {}),
      transcribe_status: "failed",
      transcribe_attempts: 3,
      transcribe_error: "transient upstream 503",
      ...(opts.errorCode ? { transcribe_error_code: opts.errorCode } : {}),
    });
    const note = await inst.store.getNote(noteId);
    const meta = { ...(note.metadata ?? {}) };
    delete meta.transcribe_stub;
    await inst.store.updateNote(noteId, {
      content: note.content.replace("_Transcript pending._", "_Transcription unavailable._"),
      metadata: meta,
      skipUpdatedAt: true,
    });
  });
}

/** POST the retry endpoint. `token` overrides the operator bearer (for the
 *  read-scope 403 test). */
function retryTranscription(vault: string, noteId: string, token?: string): Promise<Response> {
  return SELF.fetch(`${base(vault)}/api/notes/${noteId}/retry-transcription`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token ?? OP}` },
  });
}

describe("per-segment transcript slots (voice W2)", () => {
  it("three-part OUT-OF-ORDER completion — each transcript lands in its own slot", async () => {
    const v = freshVault("seg");
    await pushEntitlement(v, true, 600);
    const { noteId, attIds } = await setupSegmentedVoiceNote(v, 3);
    const [p1, p2, p3] = attIds as [string, string, string];

    // Force completion order [part3, part1, part2] via backoff: only the
    // un-backed-off segment is due on each wake.
    await setBackoffFuture(v, p1);
    await setBackoffFuture(v, p2);
    await runAlarmWith(v, bytePartStub); // part 3
    let body = await noteBody(v, noteId);
    expect(body).toContain("transcript for part 3");
    expect(body).toContain("_Transcript pending (part 1)._"); // others untouched
    expect(body).toContain("_Transcript pending (part 2)._");

    await clearBackoff(v, p1);
    await runAlarmWith(v, bytePartStub); // part 1 (p2 still backed off)
    body = await noteBody(v, noteId);
    expect(body).toContain("transcript for part 1");
    expect(body).toContain("_Transcript pending (part 2)._");

    await clearBackoff(v, p2);
    await runAlarmWith(v, bytePartStub); // part 2 (last)
    body = await noteBody(v, noteId);

    // Every slot resolved to ITS OWN transcript; no pending markers linger.
    expect(body).toContain("transcript for part 1");
    expect(body).toContain("transcript for part 2");
    expect(body).toContain("transcript for part 3");
    expect(body).not.toContain("_Transcript pending");
    // All three attachments done.
    const atts = await attachments(v, noteId);
    expect(atts.map((a) => a.metadata.transcribe_status).sort()).toEqual(["done", "done", "done"]);
    // The stub cleared only after the LAST segment resolved (multi-part stub
    // persistence): the note is no longer a transcribe stub.
    const nMeta = await noteMetaViaStore(v, noteId);
    expect(nMeta.transcribe_stub).toBeUndefined();
  });

  it("un-segmented regression: a plain memo keeps the BARE markers, no (part N)", async () => {
    const v = freshVault("seg");
    await pushEntitlement(v, true, 600);
    const { noteId } = await setupVoiceNote(v); // no segment_index

    await runAlarmWith(v, stubProvider(() => ({ text: "bare transcript", audioSeconds: 30 })));

    const body = await noteBody(v, noteId);
    expect(body).toContain("bare transcript");
    expect(body).not.toContain("(part "); // never parts a single-segment memo
    expect(body).not.toContain("_Transcript pending._");
    const att = (await attachments(v, noteId))[0];
    expect(att.metadata.segment_index).toBeUndefined();
  });

  it("limit-terminal on ONE segment writes the un-parted limit marker into that slot only", async () => {
    const v = freshVault("seg");
    await pushEntitlement(v, true, 1); // 1-minute budget
    const { noteId, attIds } = await setupSegmentedVoiceNote(v, 3);
    const [, p2, p3] = attIds as [string, string, string];

    // Part 1 succeeds (60s = 1 min) → pushes the meter to the cap.
    await setBackoffFuture(v, p2);
    await setBackoffFuture(v, p3);
    await runAlarmWith(v, bytePartStub);
    expect(await noteBody(v, noteId)).toContain("transcript for part 1");

    // Part 2 is now over budget → the UN-PARTED limit marker lands in slot 2,
    // and slot 3's pending marker is undisturbed.
    await clearBackoff(v, p2);
    await runAlarmWith(v, bytePartStub);
    const body = await noteBody(v, noteId);
    expect(body).toContain("transcript for part 1");
    expect(body).toContain("Monthly voice limit reached");
    expect(body).not.toContain("_Transcript pending (part 2)._"); // slot 2 → limit
    expect(body).toContain("_Transcript pending (part 3)._"); // slot 3 untouched
  });
});

describe("retry-transcription endpoint (voice W2)", () => {
  it("retries a failed attachment → pending + marker restored + succeeds on the next wake", async () => {
    const v = freshVault("retry");
    await pushEntitlement(v, true, 600);
    const { noteId } = await setupVoiceNote(v);
    const attId = (await attachments(v, noteId))[0].id;

    // A RETRIABLE terminal (exhausted attempts, no error_code) — the class a
    // retry SHOULD recover. Set up directly so no throwing stub lingers.
    await forceFailedTerminal(v, noteId, attId);
    let att = (await attachments(v, noteId))[0];
    expect(att.metadata.transcribe_status).toBe("failed");
    expect(att.metadata.transcribe_error_code).toBeUndefined(); // retriable class
    expect(await noteBody(v, noteId)).toContain("_Transcription unavailable._");

    // Retry: 202 + wire-compatible shape, attachment back to pending, spinner
    // restored, alarm armed.
    const res = await retryTranscription(v, noteId);
    expect(res.status).toBe(202);
    const payload = (await res.json()) as Record<string, unknown>;
    expect(payload.status).toBe("queued");
    expect(payload.attachment_id).toBe(attId);
    expect(payload.transcript_note_id).toBe(noteId);
    expect(payload.retried).toBe(1);
    att = (await attachments(v, noteId))[0];
    expect(att.metadata.transcribe_status).toBe("pending");
    expect(att.metadata.transcribe_attempts).toBeUndefined(); // bookkeeping cleared
    expect(await noteBody(v, noteId)).toContain("_Transcript pending._"); // spinner restored

    // Next wake succeeds — the transcript lands where the marker was.
    await runAlarmWith(v, stubProvider(() => ({ text: "recovered on retry", audioSeconds: 30 })));
    const body = await noteBody(v, noteId);
    expect(body).toContain("recovered on retry");
    expect(body).not.toContain("_Transcript pending._");
    expect(body).not.toContain("_Transcription unavailable._");
  });

  it("respects a non-retriable size terminal — audio_too_large stays terminal on retry", async () => {
    const v = freshVault("retry");
    await pushEntitlement(v, true, 600);
    const { noteId, audioPath } = await setupVoiceNote(v);

    // Swap the R2 object for one just over the ceiling → HEAD-gate terminal with
    // the audio_too_large code (a retry can't shrink the file).
    await env.ATTACHMENTS.put(r2Key(v, audioPath), new Uint8Array(MAX_TRANSCRIBE_BYTES + 1));
    await runAlarmWith(v, stubProvider(() => ({ text: "never", audioSeconds: 1 })));
    let att = (await attachments(v, noteId))[0];
    expect(att.metadata.transcribe_status).toBe("failed");
    expect(att.metadata.transcribe_error_code).toBe("audio_too_large");

    // Retry refuses (nothing retriable) and leaves the attachment terminal.
    const res = await retryTranscription(v, noteId);
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, unknown>).error).toBe("no_failed_attachment");
    att = (await attachments(v, noteId))[0];
    expect(att.metadata.transcribe_status).toBe("failed");
  });

  it("refuses honestly when nothing is failed", async () => {
    const v = freshVault("retry");
    await pushEntitlement(v, true, 600);
    const { noteId } = await setupVoiceNote(v);
    // Resolve it successfully first.
    await runAlarmWith(v, stubProvider(() => ({ text: "all good", audioSeconds: 20 })));
    expect(await noteBody(v, noteId)).toContain("all good");

    const res = await retryTranscription(v, noteId);
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, unknown>).error).toBe("no_failed_attachment");
  });

  it("enforces write scope — a read token gets 403", async () => {
    const v = freshVault("retry");
    await pushEntitlement(v, true, 600);
    const { noteId } = await setupVoiceNote(v);
    const readToken = await mintToken({ vault: v, scopes: `vault:${v}:read`, vaultScope: [v] });

    const res = await retryTranscription(v, noteId, readToken);
    expect(res.status).toBe(403);
  });
});
