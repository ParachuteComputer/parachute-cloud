/**
 * add-attachment (T-476): a file whose bytes ride in the MCP call, for an AI whose runtime can't reach the ticket URL
 * (Claude's code sandbox reaches only an allow-list; its MCP calls come from Anthropic's servers). The tool is core's
 * (the engine pin); this suite pins the door's half: the bytes land in R2 through the ticket spend's own writer, the
 * cap gate ladder bites as at the mint, and the file-transfer extension is marked and advertised only where it should
 * be. Made-up files only.
 */
import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { FIRST_PARTY_CLIENT_ID } from "../src/auth.ts";
import { base, createNote, freshVault, mintToken, op, OP } from "./helpers.ts";

const BOTH_ACCEPT = "application/json, text/event-stream";
const FILES = "io.modelcontextprotocol/files";

function mcpPost(vault: string, token: string | null, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const h: Record<string, string> = { Accept: BOTH_ACCEPT, "Content-Type": "application/json", ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  return SELF.fetch(`${base(vault)}/mcp`, { method: "POST", headers: h, body: JSON.stringify(body) });
}

async function add(vault: string, args: Record<string, unknown>, token: string = OP): Promise<any> {
  return (await mcpPost(vault, token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "add-attachment", arguments: args } })).json();
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

async function digest(bytes: Uint8Array): Promise<string> {
  const sum = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return b64(sum).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function fileInput(bytes: Uint8Array, over: Record<string, unknown> = {}) {
  return { id: "f1", name: "made-up.png", mimeType: "image/png", size: bytes.length, digest: { algorithm: "sha-256", value: await digest(bytes) }, data: b64(bytes), ...over };
}

function madeUp(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

function putConfig(vault: string, body: unknown): Promise<Response> {
  return mintToken({ vault, scopes: `vault:${vault}:admin`, vaultScope: [vault], clientId: FIRST_PARTY_CLIENT_ID }).then((t) =>
    SELF.fetch(`${base(vault)}/api/internal/config`, { method: "PUT", headers: { authorization: `Bearer ${t}`, "content-type": "application/json" }, body: JSON.stringify(body) }),
  );
}

describe("add-attachment on the hosted door", () => {
  it("stores the exact bytes in R2 on the record, and the row reads back through REST", async () => {
    const v = freshVault("aa");
    const note = await createNote(v, { content: "has a file in the call" });
    const bytes = madeUp(3000);
    const msg = await add(v, { record: note.id, file: await fileInput(bytes) });
    expect(msg.error, JSON.stringify(msg.error)).toBeUndefined();
    const out = JSON.parse(msg.result.content[0].text);
    expect(out.record).toBe(note.id);
    expect(out.attachment.size).toBe(3000);
    expect(out.attachment.mime_type).toBe("image/png");

    const rows = (await (await op(v, `/api/notes/${note.id}/attachments`)).json()) as any;
    const list = Array.isArray(rows) ? rows : rows.attachments;
    expect(list.map((a: any) => a.id)).toEqual([out.attachment.id]);
    const got = await op(v, `/api/storage/${out.attachment.path}`);
    expect(got.status).toBe(200);
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes);
  });

  it("a digest that doesn't match is refused and nothing reaches R2 or the record", async () => {
    const v = freshVault("aa");
    const note = await createNote(v, { content: "n" });
    const bytes = madeUp(500);
    const msg = await add(v, { record: note.id, file: await fileInput(bytes, { digest: { algorithm: "sha-256", value: await digest(madeUp(500)) } }) });
    expect(msg.error.data.error_type).toBe("digest_mismatch");
    const rows = (await (await op(v, `/api/notes/${note.id}/attachments`)).json()) as any;
    expect((Array.isArray(rows) ? rows : rows.attachments).length).toBe(0);
    const listed = await env.ATTACHMENTS.list({ prefix: `vault-${v}/attachments/` });
    expect(listed.objects.length).toBe(0);
  });

  it("the cap gate ladder bites as at the mint: Entry tier and a full budget refuse before anything is stored", async () => {
    const v = freshVault("aa");
    const note = await createNote(v, { content: "n" });
    await putConfig(v, { caps: { notes_bytes: 100 * 1024 * 1024, attachment_bytes: 0 } });
    const entry = await add(v, { record: note.id, file: await fileInput(madeUp(64)) });
    expect(entry.error.data.error_type).toBe("attachments_not_included");

    await putConfig(v, { caps: { notes_bytes: 100 * 1024 * 1024, attachment_bytes: 1024 } });
    const full = await add(v, { record: note.id, file: await fileInput(madeUp(4096)) });
    expect(full.error.data.error_type).toBe("storage_cap_exceeded");
    expect(full.error.data.meter).toBe("attachments");
    const listed = await env.ATTACHMENTS.list({ prefix: `vault-${v}/attachments/` });
    expect(listed.objects.length).toBe(0);
  });

  it("a reader doesn't see it; tools/list marks x-mcp-file only when the client declared the extension", async () => {
    const v = freshVault("aa");
    const reader = await mintToken({ vault: v, scopes: `vault:${v}:read` });
    const rl = (await (await mcpPost(v, reader, { jsonrpc: "2.0", id: 1, method: "tools/list" })).json()) as any;
    expect(rl.result.tools.map((t: any) => t.name)).not.toContain("add-attachment");

    const plain = (await (await mcpPost(v, OP, { jsonrpc: "2.0", id: 1, method: "tools/list" })).json()) as any;
    const tool = plain.result.tools.find((t: any) => t.name === "add-attachment");
    expect(tool.inputSchema.required).toEqual(["record", "file"]);
    expect(tool.inputSchema.properties.file["x-mcp-file"]).toBeUndefined();

    const declared = (await (
      await mcpPost(v, OP, { jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/clientCapabilities": { extensions: { [FILES]: {} } } } } })
    ).json()) as any;
    const marked = declared.result.tools.find((t: any) => t.name === "add-attachment");
    expect(marked.inputSchema.properties.file["x-mcp-file"].maxSize).toBeGreaterThan(0);
  });

  it("server/discover advertises the extension inline-only, and the brief teaches the tool", async () => {
    const v = freshVault("aa");
    const res = await mcpPost(
      v,
      OP,
      { jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } } },
      { "mcp-protocol-version": "2026-07-28", "mcp-method": "server/discover" },
    );
    const body = (await res.json()) as any;
    expect(body.error, JSON.stringify(body)).toBeUndefined();
    const ext = body.result.capabilities.extensions[FILES];
    expect(ext.maxInlineBytes).toBeGreaterThan(0);
    expect(ext.upload).toBeUndefined();
    expect(body.result.instructions).toContain("add-attachment");
  });
});
