/**
 * An embedding alarm wake that is parked in a Workers AI call when the vault
 * is destroyed (T-318 review 3). Destroy wipes DO storage and clears the
 * alarm, but the running wake resumes afterwards: it must not send any more
 * of the destroyed vault's text to Workers AI, and must not write DO storage
 * (the outage-backoff keys) or re-arm an alarm into the wiped object.
 */
import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { FIRST_PARTY_CLIENT_ID } from "../src/auth.ts";
import { WorkersAiEmbeddingProvider } from "../src/embedding/workers-ai.ts";
import { base, createNote, freshVault, mintToken, op } from "./helpers.ts";

function doStub(vault: string): DurableObjectStub {
  return env.VAULT.get(env.VAULT.idFromName(vault)) as unknown as DurableObjectStub;
}

const fp = (v: string) => mintToken({ vault: v, scopes: `vault:${v}:admin`, vaultScope: [v], clientId: FIRST_PARTY_CLIENT_ID });

async function destroy(v: string): Promise<void> {
  const res = await SELF.fetch(`${base(v)}/api/internal/destroy`, {
    method: "POST",
    headers: { authorization: `Bearer ${await fp(v)}`, "content-type": "application/json" },
    body: JSON.stringify({ confirm: v }),
  });
  expect(res.status).toBe(200);
}

async function purgeCheck(v: string): Promise<any> {
  return (await SELF.fetch(`${base(v)}/__test/purge-check`)).json();
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("an embedding wake in flight across a vault destroy", () => {
  for (const outcome of ["outage", "success"] as const) {
    it(`(${outcome}) sends nothing more to Workers AI and leaves no storage or alarm behind`, async () => {
      const v = freshVault("ead");
      expect((await op(v, "")).status).toBe(200);
      // Two long notes: more than one provider call per wake (40k chars a call).
      await createNote(v, { content: Array.from({ length: 80 }, (_, i) => `alpha ${i} `.repeat(40)).join("\n\n") });
      await createNote(v, { content: Array.from({ length: 80 }, (_, i) => `bravo ${i} `.repeat(40)).join("\n\n") });

      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let entered!: () => void;
      const inFirstCall = new Promise<void>((r) => (entered = r));
      let calls = 0;
      let destroyed = false;
      let callsAfterDestroy = 0;
      const provider = new WorkersAiEmbeddingProvider({
        run: async (_m: string, inputs: { text: string[] }) => {
          calls++;
          if (destroyed) callsAfterDestroy++;
          if (calls === 1) {
            entered();
            await gate;
          }
          if (outcome === "outage") throw new Error("3040: Capacity temporarily exceeded, please try again.");
          return { data: inputs.text.map(() => [1, 0, 0]) };
        },
      });

      const wake = runInDurableObject<DurableObject, void>(doStub(v), async (inst: any) => {
        inst.__setTestEmbeddingProvider(provider);
        await inst.ctx.storage.deleteAlarm();
        await inst.ctx.storage.delete("embedding_retry_at");
        await inst.alarm();
      });
      await inFirstCall;

      await destroy(v);
      destroyed = true;
      release();
      await wake;
      await tick(200);

      const probe = await purgeCheck(v);
      const rows = Object.values(probe.sql_tables as Record<string, number>).reduce((a, b) => a + b, 0);
      expect({ callsAfterDestroy, kv_keys: probe.kv_keys, alarm: probe.alarm, sql_rows: rows }).toEqual({
        sql_rows: 0,
        callsAfterDestroy: 0,
        kv_keys: [],
        alarm: null,
      });
    });
  }
});

describe("a transcription wake in flight across a vault destroy", () => {
  it("does not send the transcript to the cleanup model and leaves no storage or alarm behind", async () => {
    const v = freshVault("etd");
    const put = await SELF.fetch(`${base(v)}/api/internal/config`, {
      method: "PUT",
      headers: { authorization: `Bearer ${await fp(v)}`, "content-type": "application/json" },
      body: JSON.stringify({ transcription: { enabled: true, minutes_limit: 600 } }),
    });
    expect(put.status).toBe(200);
    const form = new FormData();
    form.set("file", new File([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])], "memo.webm", { type: "audio/webm" }));
    const up = await op(v, "/api/storage/upload", { method: "POST", body: form });
    const path = ((await up.json()) as { path: string }).path;
    const note = (await (
      await op(v, "/api/notes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: `# Voice memo\n\n_Transcript pending._\n\n![[memo.webm]]\n` }),
      })
    ).json()) as { id: string };

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inWhisper = new Promise<void>((r) => (entered = r));
    let cleanupCalls = 0;
    const provider = {
      name: "test-stub",
      async available() {
        return { ok: true as const };
      },
      async transcribe() {
        entered();
        await gate;
        return { text: "the private words of a memo", audioSeconds: 6 };
      },
    };
    const cleanup = {
      async run() {
        cleanupCalls++;
        return { response: "The private words of a memo." };
      },
    };
    await runInDurableObject<DurableObject, void>(doStub(v), async (inst: any) => {
      inst.__setTestProvider(provider);
      inst.__setTestCleanup(cleanup);
      inst.__setTestEmbeddingProvider(new WorkersAiEmbeddingProvider({ run: async (_m: string, i: { text: string[] }) => ({ data: i.text.map(() => [1, 0, 0]) }) }));
    });
    const link = await op(v, `/api/notes/${note.id}/attachments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, mimeType: "audio/webm", transcribe: true }),
    });
    expect(link.status).toBe(201);
    const wake = runInDurableObject<DurableObject, void>(doStub(v), async (inst: any) => {
      // A throw here (the drain reading a wiped table) is the runtime's alarm retry, not this test's point.
      await inst.alarm().catch(() => undefined);
    });
    await inWhisper;

    await destroy(v);
    release();
    await wake;
    await tick(200);

    const probe = await purgeCheck(v);
    expect({ cleanupCalls, kv_keys: probe.kv_keys, alarm: probe.alarm }).toEqual({ cleanupCalls: 0, kv_keys: [], alarm: null });
  });
});
