/**
 * Account closed (T-318) — the vault half of "a delete request severs access
 * NOW". Vault tokens the identity worker hands tenants are stateless (no
 * registry row → nothing for the revocation list to name), so before this a
 * deleted account's 15-minute vault token kept working until it expired. The
 * identity worker now pushes `{closed: true}` through the platform config
 * seam at request time and `{closed: false}` on undo; this suite pins what
 * the DO does with it, against a real workerd DO + R2:
 *
 *   - every tenant door (REST, MCP, landing, the WS socket, tickets) refuses
 *     while closed, for a token that worked a moment earlier — the 401
 *     `account_closed` answer only AFTER the credential checks out;
 *   - a caller with no valid credential gets byte-for-byte the answer an open
 *     or never-created vault gives, so knowing a vault name does not tell a
 *     stranger its owner asked to delete their account;
 *   - the platform seam stays open (first-party config read, destroy), and a
 *     tenant admin token still cannot flip the flag;
 *   - re-opening restores access with the data untouched;
 *   - the staging purge probe reports a destroyed vault as indistinguishable
 *     from a never-created one, with zero R2 objects under its prefix.
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { FIRST_PARTY_CLIENT_ID } from "../src/auth.ts";
import { base, createNote, freshVault, mintToken, OP, op } from "./helpers.ts";

function firstParty(vault: string): Promise<string> {
  return mintToken({ vault, scopes: `vault:${vault}:admin`, vaultScope: [vault], clientId: FIRST_PARTY_CLIENT_ID });
}

/** A tenant token exactly like `POST /account/vaults/<name>/token` mints. */
function tenant(vault: string): Promise<string> {
  return mintToken({
    vault,
    scopes: `vault:${vault}:read vault:${vault}:write`,
    vaultScope: [vault],
    clientId: "parachute-account",
  });
}

async function setClosed(vault: string, token: string, closed: boolean): Promise<Response> {
  return SELF.fetch(`${base(vault)}/api/internal/config`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ closed }),
  });
}

function asTenant(vault: string, token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return SELF.fetch(`${base(vault)}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.headers as Record<string, string> | undefined) },
  });
}

function mcpList(vault: string, token: string): Promise<Response> {
  return asTenant(vault, token, "/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
}

describe("closed account — tenant tokens refused at once, platform seam still open", () => {
  it("a live tenant token stops working the moment the vault is closed, and works again on re-open", async () => {
    const v = freshVault("cl");
    const note = await createNote(v, { content: "still here after undo" });
    const tok = await tenant(v);

    // Baseline: the token works on every tenant door.
    expect((await asTenant(v, tok, `/api/notes/${note.id}`)).status).toBe(200);
    expect((await mcpList(v, tok)).status).toBe(200);
    expect((await asTenant(v, tok, "")).status).toBe(200);
    const countBefore = ((await (await asTenant(v, tok, "/api/notes")).json()) as unknown[]).length;

    const fp = await firstParty(v);
    const closeRes = await setClosed(v, fp, true);
    expect(closeRes.status).toBe(200);
    expect(((await closeRes.json()) as { closed: boolean }).closed).toBe(true);

    // The SAME unexpired token, now refused on REST read, REST write, MCP, landing.
    const read = await asTenant(v, tok, `/api/notes/${note.id}`);
    expect(read.status).toBe(401);
    expect(((await read.json()) as { error_type: string }).error_type).toBe("account_closed");
    const write = await asTenant(v, tok, "/api/notes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "must not land" }),
    });
    expect(write.status).toBe(401);
    expect((await mcpList(v, tok)).status).toBe(401);
    expect((await asTenant(v, tok, "")).status).toBe(401);

    // The platform seam is still reachable (the sweep's destroy and undo's
    // re-open both ride it) and reports the flag.
    const cfg = await SELF.fetch(`${base(v)}/api/internal/config`, { headers: { authorization: `Bearer ${fp}` } });
    expect(cfg.status).toBe(200);
    expect(((await cfg.json()) as { closed: boolean }).closed).toBe(true);

    // Re-open: the token works again and the data is exactly as it was.
    expect((await setClosed(v, fp, false)).status).toBe(200);
    const again = await asTenant(v, tok, `/api/notes/${note.id}?content=full`);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { content: string }).content).toContain("still here after undo");
    // ...and the refused write never landed.
    const list = await asTenant(v, tok, "/api/notes");
    expect(((await list.json()) as unknown[]).length).toBe(countBefore);
  });

  it("the flag survives a plain caps push and is cleared only by an explicit closed:false", async () => {
    const v = freshVault("cl");
    await createNote(v, { content: "x" });
    const fp = await firstParty(v);
    expect((await setClosed(v, fp, true)).status).toBe(200);
    // A caps-only push (no `closed` key) must not silently re-open the vault.
    const caps = await SELF.fetch(`${base(v)}/api/internal/config`, {
      method: "PUT",
      headers: { authorization: `Bearer ${fp}`, "content-type": "application/json" },
      body: JSON.stringify({ caps: { notes_bytes: 1_000_000, attachment_bytes: 1_000_000 } }),
    });
    expect(((await caps.json()) as { closed: boolean }).closed).toBe(true);
    expect((await asTenant(v, await tenant(v), "/api/notes")).status).toBe(401);
  });

  it("a tenant ADMIN token cannot flip the flag (platform-only seam), and a non-boolean is refused", async () => {
    const v = freshVault("cl");
    await createNote(v, { content: "x" });
    const ownerAdmin = await mintToken({ vault: v, scopes: `vault:${v}:admin`, vaultScope: [v], clientId: "some-dcr-client" });
    expect((await setClosed(v, ownerAdmin, true)).status).toBe(403);
    const bad = await SELF.fetch(`${base(v)}/api/internal/config`, {
      method: "PUT",
      headers: { authorization: `Bearer ${await firstParty(v)}`, "content-type": "application/json" },
      body: JSON.stringify({ closed: "yes" }),
    });
    expect(bad.status).toBe(400);
  });
});

/** Everything an outsider can observe about one response, with the vault
 *  name folded out so three different vaults compare equal. */
async function observe(res: Response, vault: string): Promise<{ status: number; body: string; challenge: string | null }> {
  const fold = (x: string) => x.split(vault).join("<vault>");
  const challenge = res.headers.get("www-authenticate");
  return { status: res.status, body: fold(await res.text()), challenge: challenge === null ? null : fold(challenge) };
}

/** The doors a stranger can knock on, each with the credential they hold. */
async function strangerProbes(vault: string): Promise<Record<string, Awaited<ReturnType<typeof observe>>>> {
  const wrongVault = await tenant(`${vault}-other`); // a real token, for some OTHER vault
  const forged = await mintToken({ vault, scopes: `vault:${vault}:read`, iss: "https://evil.example" });
  const expired = await mintToken({ vault, scopes: `vault:${vault}:read`, expiresIn: "-1m" });
  const out: Record<string, Awaited<ReturnType<typeof observe>>> = {};
  for (const [cred, hdr] of [
    ["none", {}],
    ["garbage", { authorization: "Bearer not-a-token" }],
    ["wrong-vault", { authorization: `Bearer ${wrongVault}` }],
    ["forged", { authorization: `Bearer ${forged}` }],
    ["expired", { authorization: `Bearer ${expired}` }],
  ] as const) {
    const h = hdr as Record<string, string>;
    out[`${cred} GET /api/notes`] = await observe(await SELF.fetch(`${base(vault)}/api/notes`, { headers: h }), vault);
    out[`${cred} POST /api/notes`] = await observe(
      await SELF.fetch(`${base(vault)}/api/notes`, {
        method: "POST",
        headers: { ...h, "content-type": "application/json" },
        body: JSON.stringify({ content: "must not land" }),
      }),
      vault,
    );
    out[`${cred} GET landing`] = await observe(await SELF.fetch(base(vault), { headers: h }), vault);
    out[`${cred} GET /api/subscribe (SSE)`] = await observe(await SELF.fetch(`${base(vault)}/api/subscribe`, { headers: h }), vault);
    out[`${cred} GET unknown path`] = await observe(await SELF.fetch(`${base(vault)}/nope`, { headers: h }), vault);
    out[`${cred} POST /mcp`] = await observe(
      await SELF.fetch(`${base(vault)}/mcp`, {
        method: "POST",
        headers: { ...h, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
      vault,
    );
  }
  // The root `/mcp` routes on the token's own (unverified) aud claim, so a
  // forged token picks the vault; the DO must still answer generically.
  out["forged POST root /mcp"] = await observe(
    await SELF.fetch("https://u.parachute.computer/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${forged}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }),
    vault,
  );
  // A guessed ticket id, on both spend verbs.
  const guess = `deadbeef${"0".repeat(56)}`;
  out["GET guessed ticket"] = await observe(await SELF.fetch(`${base(vault)}/tickets/${guess}`), vault);
  out["PUT guessed ticket"] = await observe(
    await SELF.fetch(`${base(vault)}/tickets/${guess}`, { method: "PUT", headers: { "content-length": "1" }, body: "x" }),
    vault,
  );
  // The live-query upgrade carries no credential at all (auth is the first
  // socket message), so it must be accepted the same way.
  const ws = await SELF.fetch(`${base(vault)}/api/subscribe`, { headers: { Upgrade: "websocket" } });
  out["WS upgrade"] = { status: ws.status, body: "", challenge: null };
  if (ws.webSocket) {
    ws.webSocket.accept();
    ws.webSocket.close();
  }
  return out;
}

describe("closed account — a stranger learns nothing about the account's state", () => {
  it("every door answers a caller without a valid credential exactly as it does for an open or never-created vault", async () => {
    const open = freshVault("so");
    await createNote(open, { content: "x" });
    const closed = freshVault("sc");
    await createNote(closed, { content: "x" });
    expect((await setClosed(closed, await firstParty(closed), true)).status).toBe(200);
    const never = freshVault("sn");

    const openSeen = await strangerProbes(open);
    const closedSeen = await strangerProbes(closed);
    const neverSeen = await strangerProbes(never);

    expect(JSON.stringify(closedSeen)).not.toContain("account_closed");
    expect(closedSeen).toEqual(openSeen);
    expect(neverSeen).toEqual(openSeen);
    // Sanity: the probes really were refused (not a vacuous equality).
    expect(closedSeen["none GET /api/notes"]!.status).toBe(401);
    expect(closedSeen["none POST /mcp"]!.challenge).toContain("resource_metadata=");
    expect(closedSeen["WS upgrade"]!.status).toBe(101);
  });

  it("the owner's own token still gets the specific account_closed answer, on every door", async () => {
    const v = freshVault("sc");
    const note = await createNote(v, { content: "x" });
    const tok = await tenant(v);
    expect((await setClosed(v, await firstParty(v), true)).status).toBe(200);
    for (const res of [
      await asTenant(v, tok, `/api/notes/${note.id}`),
      await asTenant(v, tok, ""),
      await mcpList(v, tok),
    ]) {
      expect(res.status).toBe(401);
      expect(((await res.json()) as { error_type: string }).error_type).toBe("account_closed");
    }
  });

  it("the live-query socket accepts the upgrade but refuses a valid token with 4401 'account closed', streaming nothing", async () => {
    const v = freshVault("sc");
    await createNote(v, { content: "secret", tags: ["watch"] });
    expect((await setClosed(v, await firstParty(v), true)).status).toBe(200);
    const res = await SELF.fetch(`${base(v)}/api/subscribe?tag=watch`, { headers: { Upgrade: "websocket" } });
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    ws.accept();
    const frames: string[] = [];
    ws.addEventListener("message", (e: MessageEvent) => frames.push(String(e.data)));
    // Bounded: if the socket is (wrongly) admitted it stays open, and the test
    // must fail fast rather than ride the pool's 300 s timeout.
    const closedWith = new Promise<{ code: number; reason: string } | "still open">((resolve) => {
      const t = setTimeout(() => resolve("still open"), 10_000);
      ws.addEventListener("close", (e: CloseEvent) => {
        clearTimeout(t);
        resolve({ code: e.code, reason: e.reason });
      });
    });
    ws.send(JSON.stringify({ type: "auth", token: await tenant(v) }));
    const outcome = await closedWith;
    expect(frames).toEqual([]);
    expect(outcome).toEqual({ code: 4401, reason: "account closed" });
    if (outcome === "still open") ws.close();
  });

  it("a real ticket is refused while closed with the uniform not-found answer, and is not spent by the refusal", async () => {
    const v = freshVault("sc");
    const note = await createNote(v, { content: "n" });
    const bytes = new Uint8Array([1, 2, 3]);
    const mint = await SELF.fetch(`${base(v)}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${OP}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "request-attachment-upload", arguments: { note: note.id, filename: "a.bin", size_bytes: bytes.byteLength } },
      }),
    });
    const ticket = JSON.parse(((await mint.json()) as any).result.content[0].text);
    const spendUrl = `https://vault.test${new URL(ticket.url).pathname}`;
    const spend = () =>
      SELF.fetch(spendUrl, { method: "PUT", headers: { "content-length": String(bytes.byteLength) }, body: bytes });

    const fp = await firstParty(v);
    expect((await setClosed(v, fp, true)).status).toBe(200);
    const refused = await spend();
    expect(refused.status).toBe(404);
    expect(((await refused.json()) as { error_type: string }).error_type).toBe("not_found");

    // Undo inside the ticket's TTL: the refusal did not spend it.
    expect((await setClosed(v, fp, false)).status).toBe(200);
    expect((await spend()).status).toBe(201);
  });
});

describe("GET /__test/purge-check — the staging purge probe", () => {
  async function probe(vault: string): Promise<{
    sql_rows_total: number;
    sql_tables: Record<string, number>;
    kv_keys: string[];
    alarm: number | null;
    r2_objects: number;
  }> {
    const res = await SELF.fetch(`${base(vault)}/__test/purge-check`);
    expect(res.status).toBe(200);
    return (await res.json()) as never;
  }

  it("a destroyed vault probes like a never-created one: no user rows, no KV keys, no alarm, empty R2 prefix", async () => {
    const v = freshVault("pc");
    await createNote(v, { content: "erase me" });
    const fd = new FormData();
    fd.append("file", new File([new Uint8Array(64)], "a.bin", { type: "application/octet-stream" }));
    expect((await op(v, "/api/storage/upload", { method: "POST", body: fd })).status).toBe(201);
    const exp = await op(v, "/api/export");
    expect(exp.status).toBe(200);
    await exp.arrayBuffer();

    const before = await probe(v);
    expect(before.sql_rows_total).toBeGreaterThan(0);
    expect(before.r2_objects).toBeGreaterThanOrEqual(2); // the attachment + the export tarball
    expect(before.kv_keys).toContain("config");

    const fp = await firstParty(v);
    const destroy = await SELF.fetch(`${base(v)}/api/internal/destroy`, {
      method: "POST",
      headers: { authorization: `Bearer ${fp}`, "content-type": "application/json" },
      body: JSON.stringify({ confirm: v }),
    });
    expect(destroy.status).toBe(200);

    const after = await probe(v);
    const never = await probe(freshVault("never"));
    expect(after.r2_objects).toBe(0);
    expect(after.kv_keys).toEqual([]);
    expect(after.alarm).toBeNull();
    expect(after.sql_rows_total).toBeLessThanOrEqual(never.sql_rows_total);
    // Probing must not itself re-persist anything into the destroyed DO.
    expect((await probe(v)).kv_keys).toEqual([]);
  });
});
