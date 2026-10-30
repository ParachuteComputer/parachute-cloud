/**
 * An upload that is already streaming when the account closes or the vault is
 * destroyed (T-318 day review, reviewer c). The closed and destroyed checks in
 * `fetch()` run when a request STARTS; a slow body keeps the handler alive
 * past a close or a destroy, and its R2 object lands after destroy's prefix
 * purge ran. Nothing purges a destroyed vault again (the account-delete sweep
 * destroys once, then drops the D1 rows), so a late object would survive
 * forever. Pins `VaultDO.refuseLateWrite` on both upload doors.
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

/** A request body sent as `head`, then held open until `release()`, then `tail`. */
function slowBody(head: Uint8Array, tail: Uint8Array): { body: ReadableStream<Uint8Array>; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const body = new ReadableStream<Uint8Array>({
    async start(c) {
      c.enqueue(head);
      await gate;
      c.enqueue(tail);
      c.close();
    },
  });
  return { body, release };
}

/** Start a ticket PUT whose body is held open until `release()`. */
function slowTicketUpload(path: string, size: number): { done: Promise<Response>; release: () => void } {
  const { body, release } = slowBody(new Uint8Array(size / 2), new Uint8Array(size / 2));
  const done = SELF.fetch(`https://vault.test${path}`, {
    method: "PUT",
    headers: { "content-length": String(size) },
    body,
    duplex: "half",
  });
  return { done, release };
}

/** Start a REST `POST /api/storage/upload` whose multipart body is held open until `release()`. */
function slowStorageUpload(v: string): { done: Promise<Response>; release: () => void } {
  const boundary = "inflight-boundary";
  const enc = new TextEncoder();
  const head = enc.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="slow.txt"\r\nContent-Type: text/plain\r\n\r\n` +
      "a".repeat(512),
  );
  const tail = enc.encode("b".repeat(512) + `\r\n--${boundary}--\r\n`);
  const { body, release } = slowBody(head, tail);
  const done = SELF.fetch(`${base(v)}/api/storage/upload`, {
    method: "POST",
    headers: { authorization: `Bearer ${OP}`, "content-type": `multipart/form-data; boundary=${boundary}` },
    body,
    duplex: "half",
  });
  return { done, release };
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

describe("an upload in flight across an account close or a vault destroy", () => {
  it("a ticket upload streaming when the account closes is refused and its object deleted", async () => {
    const v = freshVault("ifc");
    const note = await createNote(v, { content: "n" });
    const path = await mintUploadTicket(v, note.id, 1024);
    const up = slowTicketUpload(path, 1024);
    await tick(300); // the DO is now inside handleTicketSpend, piping the body

    const close = await SELF.fetch(`${base(v)}/api/internal/config`, {
      method: "PUT",
      headers: { authorization: `Bearer ${await fp(v)}`, "content-type": "application/json" },
      body: JSON.stringify({ closed: true }),
    });
    expect(close.status).toBe(200);

    up.release();
    const res = await up.done;
    expect({ status: res.status, body: await res.json() }).toMatchObject({ status: 401, body: { error_type: "account_closed" } });
    const probe = await purgeCheck(v);
    expect({ r2_objects: probe.r2_objects, attachments: probe.sql_tables.attachments }).toEqual({ r2_objects: 0, attachments: 0 });
  });

  it("a ticket upload streaming when the vault is destroyed leaves nothing behind", async () => {
    const v = freshVault("ifd");
    const note = await createNote(v, { content: "n" });
    const path = await mintUploadTicket(v, note.id, 1024);
    const up = slowTicketUpload(path, 1024);
    await tick(300);

    await destroy(v);

    up.release();
    const res = await up.done;
    const probe = await purgeCheck(v);
    // The R2 object and the r2_bytes meter key were both written AFTER the
    // purge + deleteAll before the fix.
    expect({ upload: res.status, r2_objects: probe.r2_objects, kv_keys: probe.kv_keys }).toEqual({
      upload: 410,
      r2_objects: 0,
      kv_keys: [],
    });
  });

  it("a REST storage upload streaming when the vault is destroyed leaves nothing behind", async () => {
    const v = freshVault("ifs");
    await createNote(v, { content: "n" });
    const up = slowStorageUpload(v);
    await tick(300); // the DO is now awaiting formData()

    await destroy(v);

    up.release();
    const res = await up.done;
    const probe = await purgeCheck(v);
    expect({ upload: res.status, r2_objects: probe.r2_objects, kv_keys: probe.kv_keys }).toEqual({
      upload: 410,
      r2_objects: 0,
      kv_keys: [],
    });
  });
});
