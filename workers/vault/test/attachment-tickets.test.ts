/**
 * Attachment tickets — the DO mirror of the runtime-lane design (Wave 1).
 * Ground truth is bun's `src/attachment-tickets.test.ts` (parachute-vault
 * PR #611) plus core's `core/src/mcp.ts` mint tools — this suite pins the
 * DO's half: mint gate ladder (the cloud-only addition over bun), the
 * DO-storage-backed provider's single-use/expiry behavior, and byte-shape
 * parity of the spend envelope/refusals against REST's own error taxonomy.
 *
 * No tag-scope coverage here: cloud v1 has no tag-scoped tokens
 * (`rest/tag-scope.ts` — every caller's `scoped_tags` is `null`), so the
 * `noteVisible` predicate the mint tools accept is never wired on this
 * door; bun's suite covers that branch, cloud's doesn't need to.
 */
import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { FIRST_PARTY_CLIENT_ID } from "../src/auth.ts";
import { r2Key } from "../src/rest/notes.ts";
import { base, createNote, freshVault, mintToken, op, OP } from "./helpers.ts";

const BOTH_ACCEPT = "application/json, text/event-stream";

function mcpPost(vault: string, token: string | null, body: unknown): Promise<Response> {
  const h: Record<string, string> = { Accept: BOTH_ACCEPT, "Content-Type": "application/json" };
  if (token) h.Authorization = `Bearer ${token}`;
  return SELF.fetch(`${base(vault)}/mcp`, { method: "POST", headers: h, body: JSON.stringify(body) });
}

/** Call an MCP tool with the operator (full-permission) bearer; returns the
 *  parsed JSON-RPC message. */
async function callTool(vault: string, name: string, args: Record<string, unknown>, id = 1): Promise<any> {
  const res = await mcpPost(vault, OP, { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  return res.json();
}

/** Parse a successful tool call's `content[0].text` (core's `JSON.stringify(out)`). */
function toolResult(msg: any): any {
  return JSON.parse(msg.result.content[0].text);
}

function firstPartyToken(vault: string): Promise<string> {
  return mintToken({ vault, scopes: `vault:${vault}:admin`, vaultScope: [vault], clientId: FIRST_PARTY_CLIENT_ID });
}

function putConfig(vault: string, token: string, body: unknown): Promise<Response> {
  return SELF.fetch(`${base(vault)}/api/internal/config`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function doStub(vault: string): DurableObjectStub {
  return env.VAULT.get(env.VAULT.idFromName(vault)) as unknown as DurableObjectStub;
}

describe("attachment tickets — discoverability", () => {
  it("tools/list includes both mint tools; initialize's instructions teach them", async () => {
    const v = freshVault("tk");
    const list = await mcpPost(v, OP, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names = ((await list.json()) as any).result.tools.map((t: any) => t.name);
    expect(names).toContain("request-attachment-upload");
    expect(names).toContain("request-attachment-download");

    const init = await mcpPost(v, OP, {
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
    });
    const instructions = ((await init.json()) as any).result.instructions as string;
    expect(instructions).toContain("request-attachment-upload");
    expect(instructions).toContain("request-attachment-download");
  });

  it("a read-only token still sees the download mint (read-verb) but NOT the upload mint (write-verb)", async () => {
    const v = freshVault("tk");
    const token = await mintToken({ vault: v, scopes: `vault:${v}:read` });
    const list = await mcpPost(v, token, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names = ((await list.json()) as any).result.tools.map((t: any) => t.name);
    expect(names).toContain("request-attachment-download");
    expect(names).not.toContain("request-attachment-upload");
  });
});

describe("attachment tickets — upload mint → spend round trip", () => {
  it("mint → PUT spend → 201 with the registered attachment row; meters the bytes", async () => {
    const v = freshVault("tk");
    const note = await createNote(v, { content: "carries a generated image" });
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    const mint = await callTool(v, "request-attachment-upload", {
      note: note.id,
      filename: "out.png",
      size_bytes: bytes.byteLength,
      mime_type: "image/png",
    });
    const ticket = toolResult(mint);
    expect(ticket.method).toBe("PUT");
    expect(typeof ticket.url).toBe("string");
    expect(ticket.url).toContain(`/vault/${v}/tickets/`);
    expect(ticket.max_bytes).toBe(bytes.byteLength);
    expect(typeof ticket.curl_example).toBe("string");
    expect(ticket.curl_example).toContain("--data-binary");

    const path = new URL(ticket.url).pathname;
    const spend = await SELF.fetch(`https://vault.test${path}`, {
      method: "PUT",
      headers: { "content-type": "image/png", "content-length": String(bytes.byteLength) },
      body: bytes,
    });
    expect(spend.status).toBe(201);
    const attachment = (await spend.json()) as any;
    expect(attachment.noteId).toBe(note.id);
    expect(attachment.mimeType).toBe("image/png");
    expect(attachment.metadata.original_name).toBe("out.png");
    expect(attachment.metadata.size).toBe(bytes.byteLength);

    // Meter bumped — visible on the read-scoped landing.
    const landing = await op(v, "");
    expect(((await landing.json()) as any).stats).toBeDefined();

    // Byte-round-trip via REST GET (the row's path resolves through the
    // usual storage byte-serve — proves the ticket wrote real R2 bytes, not
    // just a row).
    const get = await op(v, `/api/storage/${attachment.path}`);
    expect(get.status).toBe(200);
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(bytes);
  });

  it("a spent upload ticket 404s on re-spend (single-use, no oracle)", async () => {
    const v = freshVault("tk");
    const note = await createNote(v, { content: "n" });
    const mint = toolResult(
      await callTool(v, "request-attachment-upload", { note: note.id, filename: "a.bin", size_bytes: 4 }),
    );
    const path = new URL(mint.url).pathname;
    const bytes = new Uint8Array([9, 9, 9, 9]);
    const first = await SELF.fetch(`https://vault.test${path}`, {
      method: "PUT",
      headers: { "content-length": "4" },
      body: bytes,
    });
    expect(first.status).toBe(201);

    const second = await SELF.fetch(`https://vault.test${path}`, {
      method: "PUT",
      headers: { "content-length": "4" },
      body: bytes,
    });
    expect(second.status).toBe(404);
    const body = (await second.json()) as any;
    expect(body.error_type).toBe("not_found");
    expect(body.how_to).toContain("request-attachment-upload");
  });

  it("an unknown ticket id 404s the SAME shape as a spent one (uniform-404, no oracle)", async () => {
    const v = freshVault("tk");
    const res = await SELF.fetch(`${base(v)}/tickets/deadbeef${"0".repeat(56)}`, {
      method: "PUT",
      headers: { "content-length": "1" },
      body: new Uint8Array([1]),
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).error_type).toBe("not_found");
  });

  it("spend against the WRONG vault's ticket route 404s (vault-scoped)", async () => {
    const v = freshVault("tk");
    const other = freshVault("tk-other");
    const note = await createNote(v, { content: "n" });
    const mint = toolResult(
      await callTool(v, "request-attachment-upload", { note: note.id, filename: "a.bin", size_bytes: 4 }),
    );
    const ticketId = new URL(mint.url).pathname.split("/").pop();
    const wrongVaultRes = await SELF.fetch(`${base(other)}/tickets/${ticketId}`, {
      method: "PUT",
      headers: { "content-length": "4" },
      body: new Uint8Array([1, 2, 3, 4]),
    });
    expect(wrongVaultRes.status).toBe(404);
  });

  it("Content-Length over the ticket's declared size → 413 file_too_large, byte-shaped", async () => {
    const v = freshVault("tk");
    const note = await createNote(v, { content: "n" });
    const mint = toolResult(
      await callTool(v, "request-attachment-upload", { note: note.id, filename: "a.bin", size_bytes: 4 }),
    );
    const path = new URL(mint.url).pathname;
    const oversized = new Uint8Array(10);
    const res = await SELF.fetch(`https://vault.test${path}`, {
      method: "PUT",
      headers: { "content-length": "10" },
      body: oversized,
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as any;
    expect(body.error_type).toBe("file_too_large");
    expect(body.limit).toBe(4);
    expect(body.got).toBe(10);
  });

  it("a missing Content-Length header → 411 (cloud-only divergence from bun: streamed R2 PUT needs a known length up front; bun can afford to buffer-then-check). curl --data-binary always sends one — a truly length-less body needs a genuine ReadableStream, since fetch auto-computes Content-Length for a fixed-size body.", async () => {
    const v = freshVault("tk");
    const note = await createNote(v, { content: "n" });
    const mint = toolResult(
      await callTool(v, "request-attachment-upload", { note: note.id, filename: "a.bin", size_bytes: 4 }),
    );
    const path = new URL(mint.url).pathname;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4]));
        controller.close();
      },
    });
    const res = await SELF.fetch(`https://vault.test${path}`, {
      method: "PUT",
      body: stream,
      duplex: "half",
    });
    expect(res.status).toBe(411);
    expect(((await res.json()) as any).error_type).toBe("length_required");
  });

  it("transcribe:true at mint stamps the attachment pending + the note transcribe_stub, mirroring REST's own attach route", async () => {
    const v = freshVault("tk");
    const note = await createNote(v, { content: "_Transcript pending._" });
    const mint = toolResult(
      await callTool(v, "request-attachment-upload", {
        note: note.id,
        filename: "memo.webm",
        size_bytes: 4,
        mime_type: "audio/webm",
        transcribe: true,
      }),
    );
    const path = new URL(mint.url).pathname;
    const spend = await SELF.fetch(`https://vault.test${path}`, {
      method: "PUT",
      headers: { "content-length": "4" },
      body: new Uint8Array([1, 2, 3, 4]),
    });
    expect(spend.status).toBe(201);
    const attachment = (await spend.json()) as any;
    expect(attachment.metadata.transcribe_status).toBe("pending");
    expect(attachment.metadata.transcribe_origin).toBe("legacy");

    // Read the note straight off the DO store, NOT via a follow-up REST
    // call: `scheduleTranscription()` really does arm the DO's transcription
    // alarm (same as REST's own `transcribe:true` path), and the vitest
    // pool can let an armed alarm fire opportunistically before the next
    // request — which would legitimately replace `_Transcript pending._`
    // with a terminal marker and clear `transcribe_stub` (no live AI
    // binding in this test env). Reading immediately, in the same tick as
    // the spend, narrows but does not close that window (observed live,
    // cloud#171) — `deleteAlarm()` first removes the armed alarm the pool
    // could opportunistically fire at all, mirroring the fix
    // `transcription-do.test.ts`'s `runAlarmWith` applies for the identical
    // race.
    await runInDurableObject<DurableObject, void>(doStub(v), async (inst: any) => {
      await inst.ctx.storage.deleteAlarm();
      const stored = await inst.store.getNote(note.id);
      expect(stored.metadata.transcribe_stub).toBe(true);
    });
  });
});

describe("attachment tickets — download mint → spend round trip", () => {
  it("mint → GET spend → byte-equal bytes; second spend 404s", async () => {
    const v = freshVault("tk");
    const note = await createNote(v, { content: "n" });
    const bytes = new Uint8Array([5, 4, 3, 2, 1]);
    const uploadMint = toolResult(
      await callTool(v, "request-attachment-upload", { note: note.id, filename: "d.bin", size_bytes: bytes.byteLength }),
    );
    const uploadPath = new URL(uploadMint.url).pathname;
    const uploaded = (await (
      await SELF.fetch(`https://vault.test${uploadPath}`, {
        method: "PUT",
        headers: { "content-length": String(bytes.byteLength) },
        body: bytes,
      })
    ).json()) as any;

    const dlMint = toolResult(await callTool(v, "request-attachment-download", { attachment_id: uploaded.id }, 2));
    expect(dlMint.method).toBe("GET");
    expect(dlMint.mime_type).toBe(uploaded.mimeType);
    const dlPath = new URL(dlMint.url).pathname;

    const first = await SELF.fetch(`https://vault.test${dlPath}`);
    expect(first.status).toBe(200);
    expect(first.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(bytes);

    const second = await SELF.fetch(`https://vault.test${dlPath}`);
    expect(second.status).toBe(404);
  });

  it("the ROW deleted between mint and spend → the SAME uniform 404 as an unknown ticket (no oracle)", async () => {
    const v = freshVault("tk");
    const note = await createNote(v, { content: "n" });
    const uploadMint = toolResult(
      await callTool(v, "request-attachment-upload", { note: note.id, filename: "d.bin", size_bytes: 4 }),
    );
    const uploadPath = new URL(uploadMint.url).pathname;
    const uploaded = (await (
      await SELF.fetch(`https://vault.test${uploadPath}`, {
        method: "PUT",
        headers: { "content-length": "4" },
        body: new Uint8Array([1, 2, 3, 4]),
      })
    ).json()) as any;

    const dlMint = toolResult(await callTool(v, "request-attachment-download", { attachment_id: uploaded.id }, 2));
    await op(v, `/api/notes/${note.id}/attachments/${uploaded.id}`, { method: "DELETE" });

    const dlPath = new URL(dlMint.url).pathname;
    const spend = await SELF.fetch(`https://vault.test${dlPath}`);
    expect(spend.status).toBe(404);
    expect(((await spend.json()) as any).error_type).toBe("not_found");
  });

  it("the ROW survives but the R2 BYTES are gone (audio_retention eviction) → 404 attachment_binary_missing, distinct from a plain not_found", async () => {
    const v = freshVault("tk");
    const note = await createNote(v, { content: "n" });
    const uploadMint = toolResult(
      await callTool(v, "request-attachment-upload", { note: note.id, filename: "d.bin", size_bytes: 4 }),
    );
    const uploadPath = new URL(uploadMint.url).pathname;
    const uploaded = (await (
      await SELF.fetch(`https://vault.test${uploadPath}`, {
        method: "PUT",
        headers: { "content-length": "4" },
        body: new Uint8Array([1, 2, 3, 4]),
      })
    ).json()) as any;

    const dlMint = toolResult(await callTool(v, "request-attachment-download", { attachment_id: uploaded.id }, 2));
    // Simulate retention eviction: drop the R2 bytes but leave the row —
    // exactly what `audio_retention: "until_transcribed"` does after a
    // successful transcription.
    await env.ATTACHMENTS.delete(r2Key(v, uploaded.path));

    const dlPath = new URL(dlMint.url).pathname;
    const spend = await SELF.fetch(`https://vault.test${dlPath}`);
    expect(spend.status).toBe(404);
    expect(((await spend.json()) as any).error_type).toBe("attachment_binary_missing");
  });
});

describe("attachment tickets — the mint-time gate ladder (cloud-only, over bun)", () => {
  it("frozen vault → 402 plan_required at MINT, byte-shaped like REST's own refusal", async () => {
    const v = freshVault("tk");
    const note = await createNote(v, { content: "n" });
    await putConfig(v, await firstPartyToken(v), {
      caps: { notes_bytes: 100 * 1024 * 1024, attachment_bytes: 8 * 1024 * 1024 },
      frozen: true,
    });
    const msg = await callTool(v, "request-attachment-upload", { note: note.id, filename: "a.bin", size_bytes: 4 });
    expect(msg.error).toBeDefined();
    expect(msg.error.data.error_type).toBe("plan_required");
  });

  it("Entry tier (attachment_bytes: 0) → 403 attachments_not_included at MINT — an agent learns before curling", async () => {
    const v = freshVault("tk");
    const note = await createNote(v, { content: "n" });
    await putConfig(v, await firstPartyToken(v), {
      caps: { notes_bytes: 100 * 1024 * 1024, attachment_bytes: 0 },
    });
    const msg = await callTool(v, "request-attachment-upload", { note: note.id, filename: "a.bin", size_bytes: 4 });
    expect(msg.error).toBeDefined();
    expect(msg.error.data.error_type).toBe("attachments_not_included");

    // No ticket should have been minted — the DO's ticket table stays empty
    // for this vault (verified indirectly: a plausible-looking spend against
    // ANY id still 404s, since nothing was ever put()).
  });

  it("declared size over the remaining attachment budget → 413 storage_cap_exceeded at MINT, meter=attachments", async () => {
    const v = freshVault("tk");
    const note = await createNote(v, { content: "n" });
    await putConfig(v, await firstPartyToken(v), {
      caps: { notes_bytes: 100 * 1024 * 1024, attachment_bytes: 1024 },
    });
    const msg = await callTool(v, "request-attachment-upload", { note: note.id, filename: "big.bin", size_bytes: 4096 });
    expect(msg.error).toBeDefined();
    expect(msg.error.data.error_type).toBe("storage_cap_exceeded");
    expect(msg.error.data.meter).toBe("attachments");
    expect(msg.error.data.cap_bytes).toBe(1024);
  });

  it("size_bytes missing/invalid at mint falls through to core's OWN field-validation error (invalid_query), not the cap gate", async () => {
    const v = freshVault("tk");
    const note = await createNote(v, { content: "n" });
    // A vault with NO room at all — if the gate ran on a bogus size it would
    // still refuse, but for the WRONG reason. It must not run at all here.
    await putConfig(v, await firstPartyToken(v), { caps: { notes_bytes: 100 * 1024 * 1024, attachment_bytes: 0 } });
    const msg = await callTool(v, "request-attachment-upload", { note: note.id, filename: "a.bin" });
    expect(msg.error).toBeDefined();
    expect(msg.error.data.error_type).toBe("invalid_query");
    expect(msg.error.data.field).toBe("size_bytes");
  });

  it("mint→spend TOCTOU: two tickets minted against the SAME near-full budget — the SECOND spend is re-checked against the ACTUAL live meter and refused", async () => {
    const v = freshVault("tk");
    const note = await createNote(v, { content: "n" });
    // Budget for exactly one 600-byte file, not two.
    await putConfig(v, await firstPartyToken(v), {
      caps: { notes_bytes: 100 * 1024 * 1024, attachment_bytes: 600 },
    });

    // Both mints succeed — mint only checks r2Bytes, which hasn't moved yet.
    const mintA = toolResult(
      await callTool(v, "request-attachment-upload", { note: note.id, filename: "a.bin", size_bytes: 600 }, 1),
    );
    const mintB = toolResult(
      await callTool(v, "request-attachment-upload", { note: note.id, filename: "b.bin", size_bytes: 600 }, 2),
    );

    const spendA = await SELF.fetch(`https://vault.test${new URL(mintA.url).pathname}`, {
      method: "PUT",
      headers: { "content-length": "600" },
      body: new Uint8Array(600),
    });
    expect(spendA.status).toBe(201);

    // B's spend re-runs the SAME gate ladder against the NOW-live r2Bytes
    // (600) + its own 600 declared bytes = 1200 > the 600 cap.
    const spendB = await SELF.fetch(`https://vault.test${new URL(mintB.url).pathname}`, {
      method: "PUT",
      headers: { "content-length": "600" },
      body: new Uint8Array(600),
    });
    expect(spendB.status).toBe(413);
    const err = (await spendB.json()) as any;
    expect(err.error_type).toBe("storage_cap_exceeded");
    expect(err.meter).toBe("attachments");

    // B's ticket is CONSUMED by the refused spend (take() already deleted
    // it) — re-spending the same URL 404s, not another 413. A caller must
    // mint fresh, matching the design's "a tool call is cheaper than
    // widening the security posture" posture.
    const retry = await SELF.fetch(`https://vault.test${new URL(mintB.url).pathname}`, {
      method: "PUT",
      headers: { "content-length": "600" },
      body: new Uint8Array(600),
    });
    expect(retry.status).toBe(404);
  });
});

describe("attachment tickets — DO-storage provider (direct unit coverage)", () => {
  it("take() is atomic check-and-delete: a spent ticket never resolves twice, even called directly", async () => {
    const v = freshVault("tk");
    const note = await createNote(v, { content: "n" });
    const mint = toolResult(
      await callTool(v, "request-attachment-upload", { note: note.id, filename: "a.bin", size_bytes: 4 }),
    );
    const ticketId = new URL(mint.url).pathname.split("/").pop()!;

    await runInDurableObject<DurableObject, void>(doStub(v), async (inst: any) => {
      const provider = inst.attachmentTickets;
      const first = await provider.take(ticketId);
      expect(first).not.toBeNull();
      expect(first.kind).toBe("upload");
      const second = await provider.take(ticketId);
      expect(second).toBeNull();
    });
  });

  it("an expired ticket is rejected by the HTTP layer's expiry check even if the row is still present", async () => {
    const v = freshVault("tk");
    const note = await createNote(v, { content: "n" });
    const mint = toolResult(
      await callTool(v, "request-attachment-upload", { note: note.id, filename: "a.bin", size_bytes: 4 }),
    );
    const ticketId = new URL(mint.url).pathname.split("/").pop()!;

    // Backdate the row's expires_at directly (the provider's `take` does NOT
    // itself filter expiry — core's contract says callers must check it; the
    // HTTP spend layer is the caller that does, via `takeValidTicket`).
    await runInDurableObject<DurableObject, void>(doStub(v), async (inst: any) => {
      inst.ctx.storage.sql.exec(`UPDATE attachment_tickets SET expires_at = ? WHERE id = ?`, Date.now() - 1000, ticketId);
    });

    const res = await SELF.fetch(`${base(v)}/tickets/${ticketId}`, {
      method: "PUT",
      headers: { "content-length": "4" },
      body: new Uint8Array([1, 2, 3, 4]),
    });
    expect(res.status).toBe(404);
  });

  it("put() opportunistically sweeps already-expired rows on the next mint", async () => {
    const v = freshVault("tk");
    const note = await createNote(v, { content: "n" });
    const stale = toolResult(
      await callTool(v, "request-attachment-upload", { note: note.id, filename: "stale.bin", size_bytes: 4 }, 1),
    );
    const staleId = new URL(stale.url).pathname.split("/").pop()!;

    await runInDurableObject<DurableObject, void>(doStub(v), async (inst: any) => {
      inst.ctx.storage.sql.exec(`UPDATE attachment_tickets SET expires_at = ? WHERE id = ?`, Date.now() - 1000, staleId);
      const before = inst.ctx.storage.sql.exec(`SELECT COUNT(*) AS n FROM attachment_tickets`).toArray()[0].n;
      expect(before).toBe(1);
    });

    // A fresh mint's put() sweeps the stale row before inserting its own.
    await callTool(v, "request-attachment-upload", { note: note.id, filename: "fresh.bin", size_bytes: 4 }, 2);

    await runInDurableObject<DurableObject, void>(doStub(v), async (inst: any) => {
      const rows = inst.ctx.storage.sql.exec(`SELECT id FROM attachment_tickets`).toArray();
      expect(rows.length).toBe(1);
      expect(rows[0].id).not.toBe(staleId);
    });
  });
});
