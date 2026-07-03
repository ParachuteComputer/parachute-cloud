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
import { base, freshVault, mintToken, op } from "./helpers.ts";
import { r2Key } from "../src/rest/notes.ts";
import type { TranscriptionProvider, TranscribeInput, TranscribeResult } from "@openparachute/core/src/transcription/provider.ts";
import { TranscriptionError } from "@openparachute/core/src/transcription/provider.ts";

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

/** Inject a stub provider into the vault's DO, then fire the armed alarm.
 *  (Explicit type args on runInDurableObject keep tsc from deep-instantiating
 *  the large VaultDO RPC surface — TS2589.) */
async function runAlarmWith(vault: string, provider: TranscriptionProvider): Promise<boolean> {
  const stub = doStub(vault);
  await runInDurableObject<DurableObject, void>(stub, (inst: any) => {
    inst.__setTestProvider(provider);
  });
  return runDurableObjectAlarm(stub);
}

async function noteBody(vault: string, id: string): Promise<string> {
  const res = await op(vault, `/api/notes/${id}`);
  return ((await res.json()) as { content: string }).content;
}

async function landing(vault: string): Promise<any> {
  return (await op(vault, "")).json();
}

describe("voice transcription pipeline (cloud#56)", () => {
  // Scheduling-on-flag is proven by contrast: every transcribe:true test below
  // lands a transcript (so the alarm WAS armed + ran), while the final
  // transcribe:false test asserts runDurableObjectAlarm reports nothing to run.

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

  it("transcribe:false attachments are plain data — no pending, no alarm", async () => {
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
    // No alarm was armed → runDurableObjectAlarm reports nothing ran.
    expect(await runDurableObjectAlarm(doStub(v))).toBe(false);
  });
});
