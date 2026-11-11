/**
 * T-446 (Parachute 0.9.1) at the vault: a handover's owner cut (POST /api/internal/handover-cut, app-keys.ts).
 *
 * Identity changes a vault's owner in D1, then tells the vault to refuse every token of the previous owner issued
 * up to the handover. This pins what the vault does with that:
 *   - the old owner's tokens (a person's vault token, an app key) are refused on REST, MCP and the landing at once,
 *     while the same account's tokens for its OTHER vault keep working (the cut is this vault's alone);
 *   - the new owner reads the old notes, their history, and the write stamps (`created_by`, `*_via`) exactly as
 *     they were written: the handover rewrites nothing;
 *   - only the first party can push a cut; a malformed cut is refused.
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { base, freshVault, mintToken } from "./helpers.ts";

const MARA = "user-mara";
const BAKERY = "user-fernhill";

const call = (vault: string, path: string, token: string, init: RequestInit = {}) =>
  SELF.fetch(`${base(vault)}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) } });
const person = (vault: string, sub: string, clientId = "parachute-account") =>
  mintToken({ vault, sub, scopes: `vault:${vault}:read vault:${vault}:write`, vaultScope: [vault], clientId });
const firstParty = (vault: string, sub: string) =>
  mintToken({ vault, sub, scopes: `vault:${vault}:admin`, vaultScope: [vault], clientId: "parachute-console" });
const cut = async (vault: string, sub: string, token?: string) =>
  call(vault, "/api/internal/handover-cut", token ?? (await firstParty(vault, BAKERY)), {
    method: "POST",
    body: JSON.stringify({ sub, before: new Date().toISOString() }),
  });

describe("a handover's owner cut at the vault", () => {
  it("refuses the old owner's tokens here, keeps their other vault, and the new owner reads everything as written", async () => {
    const v = freshVault("handed");
    const w = freshVault("kept");
    const maraV = await person(v, MARA);
    const maraKey = await person(v, MARA, "parachute-app-key");
    const maraW = await person(w, MARA);

    const created = await call(v, "/api/notes", maraKey, { method: "POST", body: JSON.stringify({ content: "Sourdough, first try (made up)", path: "bakes/sourdough" }) });
    expect(created.status).toBe(201);
    const note = (await created.json()) as { id: string };
    const edit = await call(v, `/api/notes/${note.id}`, maraV, { method: "PATCH", body: JSON.stringify({ content: "Sourdough, second try (made up)", force: true }) });
    expect(edit.status).toBe(200);
    const stampsBefore = (await (await call(v, `/api/notes/${note.id}`, maraV)).json()) as Record<string, unknown>;
    const versionsBefore = await (await call(v, `/api/notes/${note.id}/versions`, maraV)).json();
    expect((await call(w, "/api/notes?limit=1", maraW)).status).toBe(200);

    // A token minted a second before the cut, so `iat` is strictly earlier whatever the clock's rounding.
    await new Promise((r) => setTimeout(r, 1100));
    const r = await cut(v, MARA);
    expect(r.status).toBe(200);

    // The old owner, every door, every kind of token they held for this vault.
    expect((await call(v, "/api/notes?limit=1", maraV)).status).toBe(401);
    expect((await call(v, "/api/notes?limit=1", maraKey)).status).toBe(401);
    expect((await call(v, "", maraV)).status).toBe(401);
    const mcp = await call(v, "/mcp", maraV, {
      method: "POST",
      headers: { accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(mcp.status).toBe(401);
    // Their other vault: untouched.
    expect((await call(w, "/api/notes?limit=1", maraW)).status).toBe(200);

    // The new owner: same note, same history, same stamps.
    const bakery = await person(v, BAKERY);
    const after = (await (await call(v, `/api/notes/${note.id}`, bakery)).json()) as Record<string, unknown>;
    for (const k of Object.keys(stampsBefore).filter((k) => /_(by|via)$|By$|Via$/.test(k))) expect(after[k]).toEqual(stampsBefore[k]);
    expect(Object.keys(stampsBefore).some((k) => /by$/i.test(k))).toBe(true);
    expect(JSON.stringify(after)).toContain(MARA);
    expect(await (await call(v, `/api/notes/${note.id}/versions`, bakery)).json()).toEqual(versionsBefore);
  });

  it("a cut is the first party's alone, and a malformed one is refused", async () => {
    const v = freshVault("handed");
    const maraV = await person(v, MARA);
    const tenantAdmin = await mintToken({ vault: v, sub: BAKERY, scopes: `vault:${v}:admin`, vaultScope: [v], clientId: "parachute-account" });
    expect((await cut(v, MARA, tenantAdmin)).status).toBe(403);
    expect((await cut(v, MARA, maraV)).status).toBe(403);
    const fp = await firstParty(v, BAKERY);
    expect((await call(v, "/api/internal/handover-cut", fp, { method: "POST", body: JSON.stringify({ sub: MARA }) })).status).toBe(400);
    expect((await call(v, "/api/internal/handover-cut", fp, { method: "POST", body: JSON.stringify({ sub: "operator", before: new Date().toISOString() }) })).status).toBe(400);
    expect((await call(v, "/api/notes?limit=1", maraV)).status).toBe(200); // nothing was cut
  });
});
