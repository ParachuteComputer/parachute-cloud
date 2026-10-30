/**
 * Review probe (T-318 day review, reviewer c): a tenant upload that is
 * already streaming when the account is closed / the vault is destroyed.
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { FIRST_PARTY_CLIENT_ID } from "../src/auth.ts";
import { base, createNote, freshVault, mintToken, OP } from "./helpers.ts";

const fp = (v: string) => mintToken({ vault: v, scopes: `vault:${v}:admin`, vaultScope: [v], clientId: FIRST_PARTY_CLIENT_ID });

async function mintUploadTicket(v: string, noteId: string, size: number): Promise<string> {
  const res = await SELF.fetch(`${base(v)}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${OP}`, accept: "application/json, text/event-stream", "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "request-attachment-upload", arguments: { note: noteId, filename: "slow.bin", size_bytes: size } },
    }),
  });
  const msg = (await res.json()) as any;
  return new URL(JSON.parse(msg.result.content[0].text).url).pathname;
}

/** Start a ticket PUT whose body is held open until `release()`. */
function slowUpload(path: string, size: number): { done: Promise<Response>; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const body = new ReadableStream<Uint8Array>({
    async start(c) {
      c.enqueue(new Uint8Array(size / 2));
      await gate;
      c.enqueue(new Uint8Array(size / 2));
      c.close();
    },
  });
  const done = SELF.fetch(`https://vault.test${path}`, {
    method: "PUT",
    headers: { "content-length": String(size) },
    body,
    // @ts-expect-error workerd accepts duplex
    duplex: "half",
  });
  return { done, release };
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("review c — in-flight upload across close / destroy", () => {
  it("an upload streaming when the account is closed does not land after the close", async () => {
    const v = freshVault("rci");
    const note = await createNote(v, { content: "n" });
    const path = await mintUploadTicket(v, note.id, 1024);
    const up = slowUpload(path, 1024);
    await tick(300); // the DO is now inside handleTicketSpend, piping the body

    const close = await SELF.fetch(`${base(v)}/api/internal/config`, {
      method: "PUT",
      headers: { authorization: `Bearer ${await fp(v)}`, "content-type": "application/json" },
      body: JSON.stringify({ closed: true }),
    });
    expect(close.status).toBe(200);

    up.release();
    const res = await up.done;
    expect(res.status).not.toBe(201);
  });

  it("an upload streaming when the vault is destroyed leaves nothing behind", async () => {
    const v = freshVault("rcd");
    const note = await createNote(v, { content: "n" });
    const path = await mintUploadTicket(v, note.id, 1024);
    const up = slowUpload(path, 1024);
    await tick(300);

    const destroy = await SELF.fetch(`${base(v)}/api/internal/destroy`, {
      method: "POST",
      headers: { authorization: `Bearer ${await fp(v)}`, "content-type": "application/json" },
      body: JSON.stringify({ confirm: v }),
    });
    expect(destroy.status).toBe(200);

    up.release();
    const res = await up.done;
    const probe = (await (await SELF.fetch(`${base(v)}/__test/purge-check`)).json()) as any;
    // The destroy already returned 200 (r2_objects_deleted=0) — nothing of
    // this vault may exist afterwards. The in-flight spend writes its R2
    // object and the r2_bytes meter AFTER the purge + deleteAll.
    expect({ upload: res.status, r2_objects: probe.r2_objects, kv_keys: probe.kv_keys }).toEqual({
      upload: res.status === 201 ? "must not be 201" : res.status,
      r2_objects: 0,
      kv_keys: [],
    });
  });
});
