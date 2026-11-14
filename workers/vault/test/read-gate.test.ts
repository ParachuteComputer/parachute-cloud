import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { WS_CLOSE } from "../src/live/ws-subscribe.ts";
import { base, createNote, freshVault, mintToken } from "./helpers.ts";

/**
 * The read gate (T-456). A token signed by the issuer, with this vault's audience, but no `vault:<this vault>:<verb>`
 * scope grants nothing here, so every door refuses it: REST, MCP, export, the live streams. Before this, the REST
 * gate checked only writes, and the coarse `permission` summary turned "no write scope" into "read", so such a token
 * read the whole vault. No mint path makes one today; this pins that one never reads.
 *
 * The REST answer is the box's (parachute-core routing.ts): 403 insufficient_scope, naming the method's scope.
 */
const SCOPELESS: Array<{ label: string; scopes: (v: string) => string }> = [
  { label: "no scope at all", scopes: () => "" },
  { label: "only non-vault scopes", scopes: () => "openid profile" },
  { label: "another vault's read scope", scopes: () => "vault:someone-else:read vault:someone-else:admin" },
  { label: "an unknown verb on this vault", scopes: (v) => `vault:${v}:export` },
];

function get(v: string, path: string, token: string): Promise<Response> {
  return SELF.fetch(`${base(v)}${path}`, { headers: { Authorization: `Bearer ${token}` } });
}

function mcp(v: string, token: string, body: unknown): Promise<Response> {
  return SELF.fetch(`${base(v)}/mcp`, {
    method: "POST",
    headers: { Accept: "application/json, text/event-stream", "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

async function wsClose(v: string, token: string): Promise<{ code: number; frames: unknown[] }> {
  const res = await SELF.fetch(`${base(v)}/api/subscribe?tag=watch`, { headers: { Upgrade: "websocket" } });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  const frames: unknown[] = [];
  ws.addEventListener("message", (e: any) => frames.push(e.data));
  const closed = new Promise<number>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("socket was not closed")), 5000);
    ws.addEventListener("close", (e: any) => {
      clearTimeout(t);
      resolve(e.code);
    });
  });
  ws.send(JSON.stringify({ type: "auth", token }));
  return { code: await closed, frames };
}

describe("read gate — a vault-audience token with no scope for this vault reads nothing", () => {
  for (const c of SCOPELESS) {
    it(`${c.label}: REST, MCP, export and the live socket all refuse`, async () => {
      const v = freshVault();
      const note = await createNote(v, { content: "a secret only the owner should read", tags: ["watch"] });
      const token = await mintToken({ vault: v, scopes: c.scopes(v) });

      for (const path of ["/api/notes", `/api/notes/${note.id}`, "/api/records", "/api/tags", "/api/vault"]) {
        const res = await get(v, path, token);
        const body = (await res.json()) as any;
        expect(res.status, `GET ${path}`).toBe(403);
        expect(body.error_type, `GET ${path}`).toBe("insufficient_scope");
        expect(body.required_scope, `GET ${path}`).toBe("vault:read");
        expect(JSON.stringify(body)).not.toContain("a secret");
      }

      const post = await SELF.fetch(`${base(v)}/api/notes`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ content: "no" }),
      });
      expect(post.status, "POST /api/notes").toBe(403);
      expect(((await post.json()) as any).required_scope, "POST names the write scope, as the box does").toBe("vault:write");

      const exp = await get(v, "/api/export", token);
      expect(exp.status, "GET /api/export").toBe(403);
      expect(await exp.text()).not.toContain("a secret");

      const call = await mcp(v, token, {
        jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "query-notes", arguments: { id: note.id } },
      });
      expect(await call.clone().text(), "MCP query-notes").not.toContain("a secret");
      expect(call.status, "MCP").toBe(403);
      // Signing in again the same way doesn't fix a 403, so MCP sends no sign-in challenge with it (a 401 does).
      expect(call.headers.get("www-authenticate"), "MCP challenge").toBeNull();

      const ws = await wsClose(v, token);
      expect(ws.code, "the live socket").toBe(WS_CLOSE.FORBIDDEN);
      expect(JSON.stringify(ws.frames)).not.toContain("a secret");
    });
  }

  it("the control: this vault's read scope still reads, and its write scope still writes", async () => {
    const v = freshVault();
    const note = await createNote(v, { content: "readable" });
    const read = await mintToken({ vault: v, scopes: `vault:${v}:read` });
    const res = await get(v, `/api/notes/${note.id}`, read);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).content).toBe("readable");
    const refused = await SELF.fetch(`${base(v)}/api/notes`, {
      method: "POST",
      headers: { Authorization: `Bearer ${read}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "no" }),
    });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as any).required_scope).toBe("vault:write");
    const write = await mintToken({ vault: v, scopes: `vault:${v}:write` });
    const made = await SELF.fetch(`${base(v)}/api/notes`, {
      method: "POST",
      headers: { Authorization: `Bearer ${write}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "yes" }),
    });
    expect(made.status).toBe(201);
  });
});
