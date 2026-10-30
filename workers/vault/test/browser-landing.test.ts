/**
 * Browser navigation to a vault's address (T-318 newuser walk, 10-30).
 *
 * The app's first-vault screen showed newcomers "your vault will live at
 * https://my.parachute.computer/vault/<name>", so people bookmarked it. Opening
 * that in a browser answered the bare landing's 401 JSON ("API key required").
 * A top-level browser navigation to exactly /vault/<name> (or /vault/<name>/)
 * with no credential now gets a 302 to the app page for that vault
 * (`CONSOLE_PUBLIC_ORIGIN/v/<name>`).
 *
 * What must NOT move: API clients (JSON Accept, or any credential) keep the
 * wire-contract answers; /mcp and /api/* are untouched; and the redirect is the
 * same for an open, a closed and a never-created vault, so a stranger learns
 * nothing about whether a name exists or its owner asked to delete it.
 */
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { FIRST_PARTY_CLIENT_ID } from "../src/auth.ts";
import { base, createNote, freshVault, mintToken } from "./helpers.ts";

/** What Chrome/Firefox send on a top-level navigation. */
const BROWSER_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

function navigate(url: string, headers: Record<string, string> = {}): Promise<Response> {
  return SELF.fetch(url, { headers: { accept: BROWSER_ACCEPT, ...headers }, redirect: "manual" });
}

function appPage(vault: string): string {
  return `${env.CONSOLE_PUBLIC_ORIGIN}/v/${vault}`;
}

async function observe(res: Response): Promise<{ status: number; location: string | null; body: string }> {
  return { status: res.status, location: res.headers.get("location"), body: await res.text() };
}

describe("browser GET of a vault's address", () => {
  it("redirects to the app page for that vault, with or without a trailing slash, on any host", async () => {
    const v = freshVault("bl");
    await createNote(v, { content: "x" });
    for (const url of [base(v), `${base(v)}/`, `https://my.parachute.computer/vault/${v}`, `https://u.parachute.computer/vault/${v}/`]) {
      const res = await navigate(url);
      expect(res.status, url).toBe(302);
      expect(res.headers.get("location"), url).toBe(appPage(v));
    }
  });

  it("names the canonical lowercase vault in the app link", async () => {
    const v = freshVault("bl");
    const res = await navigate(base(v.toUpperCase()));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(appPage(v));
  });

  it("answers an open, a closed and a never-created vault identically (no existence or closed-account oracle)", async () => {
    const open = freshVault("bo");
    await createNote(open, { content: "x" });
    const closed = freshVault("bc");
    await createNote(closed, { content: "x" });
    const fp = await mintToken({ vault: closed, scopes: `vault:${closed}:admin`, vaultScope: [closed], clientId: FIRST_PARTY_CLIENT_ID });
    const closeRes = await SELF.fetch(`${base(closed)}/api/internal/config`, {
      method: "PUT",
      headers: { authorization: `Bearer ${fp}`, "content-type": "application/json" },
      body: JSON.stringify({ closed: true }),
    });
    expect(closeRes.status).toBe(200);
    const never = freshVault("bn");

    // Normalize the name out so the three answers are comparable byte-for-byte.
    const seen = async (v: string) => {
      const o = await observe(await navigate(base(v)));
      return { ...o, location: o.location?.replace(v, "<name>") ?? null, body: o.body.replaceAll(v, "<name>") };
    };
    const openSeen = await seen(open);
    expect(openSeen.status).toBe(302);
    expect(await seen(closed)).toEqual(openSeen);
    expect(await seen(never)).toEqual(openSeen);
  });
});

describe("what the redirect must not touch", () => {
  it("an API client without a credential still gets the JSON 401", async () => {
    const v = freshVault("ba");
    for (const accept of [null, "application/json", "*/*"]) {
      const res = await SELF.fetch(base(v), { headers: accept ? { accept } : {}, redirect: "manual" });
      expect(res.status, String(accept)).toBe(401);
      expect(await res.json()).toEqual({ error: "Unauthorized", message: "API key required" });
    }
  });

  it("a browser-shaped request that carries any credential gets the wire-contract answer, not a redirect", async () => {
    const v = freshVault("bk");
    await createNote(v, { content: "x" });
    const good = await mintToken({ vault: v, scopes: `vault:${v}:read` });

    const ok = await navigate(base(v), { authorization: `Bearer ${good}` });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { name: string }).name).toBe(v);

    for (const [label, res] of [
      ["garbage bearer", await navigate(base(v), { authorization: "Bearer not-a-token" })],
      ["basic auth", await navigate(base(v), { authorization: "Basic Zm9vOmJhcg==" })],
      ["x-api-key", await navigate(base(v), { "x-api-key": "not-a-token" })],
      ["?key=", await navigate(`${base(v)}?key=not-a-token`)],
    ] as const) {
      expect(res.status, label).toBe(401);
      expect(res.headers.get("location"), label).toBeNull();
    }
  });

  it("non-GET methods on the bare address keep their answer", async () => {
    const v = freshVault("bm");
    const res = await SELF.fetch(base(v), { method: "POST", headers: { accept: BROWSER_ACCEPT }, redirect: "manual" });
    expect(res.status).toBe(405);
  });

  it("/mcp and /api/* under the vault are untouched, MCP challenge included", async () => {
    const v = freshVault("bp");
    const mcp = await navigate(`${base(v)}/mcp`);
    expect(mcp.status).toBe(401);
    expect(mcp.headers.get("www-authenticate")).toContain("resource_metadata=");
    expect(mcp.headers.get("location")).toBeNull();

    const api = await navigate(`${base(v)}/api/notes`);
    expect(api.status).toBe(401);
    expect(api.headers.get("location")).toBeNull();

    const other = await navigate(`${base(v)}/nope`);
    expect(other.status).toBe(404);
    expect(other.headers.get("location")).toBeNull();
  });
});
