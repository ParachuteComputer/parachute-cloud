/**
 * Nostr principal attribution — the CLOUD door's half (cloud#277).
 *
 * Door parity, not a nice-to-have. `@openparachute/core` is shared verbatim
 * between the two doors (`workers/vault/package.json` →
 * `file:../../../parachute-vault/core`), so core's `query-notes` manifest
 * advertises `created_via` / `last_updated_via` = `nostr:<64-hex>` to CLOUD
 * clients as well as bun ones. Before this change, cloud hardcoded
 * `via: "api"` in `src/auth.ts` and flattened to `"mcp"` in `src/mcp.ts`, so
 * it advertised a filter value it could never emit — a client filtering
 * `created_via: "nostr:…"` against a cloud vault would get a silent empty set.
 *
 * The problem being fixed: several agents, each with their own Nostr key,
 * routinely link to ONE hub user. The token's `sub` is that shared user, so
 * `created_by` / `last_updated_by` cannot tell them apart. `*_via` can.
 *
 * Wire contract: parachute-vault `docs/contracts/nostr-principal-attribution.md`.
 * Bun-side twin: `parachute-vault/src/attribution-threading.test.ts`.
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { parsePrincipalPubkey, refineMcpVia } from "../src/auth.ts";
import { base, freshVault, mintToken } from "./helpers.ts";

const BOTH_ACCEPT = "application/json, text/event-stream";

const PUBKEY_A = "a".repeat(64);
const PUBKEY_B = `e6619493${"b".repeat(56)}`;
/** Two agents, one hub user — the whole point. */
const SHARED_HUB_USER = "e6619493-shared-hub-user";

function mcpPost(vault: string, token: string, body: unknown): Promise<Response> {
  return SELF.fetch(`${base(vault)}/mcp`, {
    method: "POST",
    headers: {
      Accept: BOTH_ACCEPT,
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

async function callTool(
  vault: string,
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<any> {
  const res = await mcpPost(vault, token, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
  const body = (await res.json()) as any;
  if (body.error) throw new Error(`tools/call ${name} → ${JSON.stringify(body.error)}`);
  const text = body.result?.content?.find((c: any) => c.type === "text")?.text;
  if (typeof text !== "string") throw new Error(`no text content in ${name} result`);
  return JSON.parse(text);
}

/** A token for `pubkey` acting as `SHARED_HUB_USER` on `vault`. */
function agentToken(vault: string, pubkey: string | null): Promise<string> {
  return mintToken({
    vault,
    scopes: `vault:${vault}:write vault:${vault}:read`,
    sub: SHARED_HUB_USER,
    ...(pubkey ? { permissions: { principal_pubkey: pubkey } } : {}),
  });
}

describe("parsePrincipalPubkey — fail-soft claim parsing", () => {
  it("accepts a canonical 64-char lowercase hex pubkey", () => {
    expect(parsePrincipalPubkey({ principal_pubkey: PUBKEY_A })).toBe(PUBKEY_A);
  });

  it("returns null for absent / malformed values — never throws, never widens", () => {
    // Deliberately the OPPOSITE of a `scoped_tags` misread: that is an access
    // decision and must fail closed; this is only a label, so a bad value must
    // not reject a legitimate write nor be stored verbatim.
    expect(parsePrincipalPubkey(undefined)).toBeNull();
    expect(parsePrincipalPubkey({})).toBeNull();
    expect(parsePrincipalPubkey({ principal_pubkey: "A".repeat(64) })).toBeNull(); // uppercase
    expect(parsePrincipalPubkey({ principal_pubkey: "ab".repeat(20) })).toBeNull(); // short
    expect(parsePrincipalPubkey({ principal_pubkey: `${PUBKEY_A}0` })).toBeNull(); // long
    expect(parsePrincipalPubkey({ principal_pubkey: "z".repeat(64) })).toBeNull(); // non-hex
    expect(parsePrincipalPubkey({ principal_pubkey: "npub1qqqqq" })).toBeNull(); // bech32
    expect(parsePrincipalPubkey({ principal_pubkey: 12345 })).toBeNull();
    expect(parsePrincipalPubkey({ principal_pubkey: null })).toBeNull();
  });
});

describe("refineMcpVia — parity with the bun door", () => {
  it("keeps a nostr signer and the operator class, refines the generic ones", () => {
    expect(refineMcpVia(`nostr:${PUBKEY_A}`)).toBe(`nostr:${PUBKEY_A}`);
    expect(refineMcpVia("operator")).toBe("operator");
    expect(refineMcpVia("api")).toBe("mcp");
    expect(refineMcpVia("token:abc123")).toBe("mcp");
    expect(refineMcpVia(null)).toBe("mcp");
    expect(refineMcpVia(undefined)).toBe("mcp");
  });
});

describe("cloud door — the signer lands in both *_via columns", () => {
  it("create-note: created_via = last_updated_via = nostr:<pubkey>, created_by stays the hub user", async () => {
    const v = freshVault("nostr-create");
    const token = await agentToken(v, PUBKEY_A);
    const created = await callTool(v, token, "create-note", { content: "signed by A" });

    expect(created.createdBy).toBe(SHARED_HUB_USER);
    expect(created.lastUpdatedBy).toBe(SHARED_HUB_USER);
    expect(created.createdVia).toBe(`nostr:${PUBKEY_A}`);
    expect(created.lastUpdatedVia).toBe(`nostr:${PUBKEY_A}`);
  });

  it("a token with NO pubkey claim still records the plain `mcp` channel (no regression)", async () => {
    const v = freshVault("nostr-none");
    const token = await agentToken(v, null);
    const created = await callTool(v, token, "create-note", { content: "no claim" });
    expect(created.createdVia).toBe("mcp");
    expect(created.lastUpdatedVia).toBe("mcp");
  });

  it("a MALFORMED pubkey claim degrades to `mcp` — the write succeeds, junk is not stored", async () => {
    const v = freshVault("nostr-bad");
    const token = await mintToken({
      vault: v,
      scopes: `vault:${v}:write vault:${v}:read`,
      sub: SHARED_HUB_USER,
      permissions: { principal_pubkey: "NOT-A-PUBKEY" },
    });
    const created = await callTool(v, token, "create-note", { content: "malformed claim" });
    expect(created.createdVia).toBe("mcp");
  });

  it("THE REPORTED BUG: agent B appending to agent A's note is distinguishable", async () => {
    const v = freshVault("nostr-two");
    const tokenA = await agentToken(v, PUBKEY_A);
    const tokenB = await agentToken(v, PUBKEY_B);

    const created = await callTool(v, tokenA, "create-note", {
      content: "written by A",
      path: "Shared/Note",
    });
    await callTool(v, tokenB, "update-note", {
      id: created.id,
      append: "\n\nappended by B",
    });

    const after = await callTool(v, tokenA, "query-notes", { id: created.id });
    const note = Array.isArray(after) ? after[0] : (after.notes?.[0] ?? after);

    // Same hub user on both principal axes — correct, and unchanged.
    expect(note.createdBy).toBe(SHARED_HUB_USER);
    expect(note.lastUpdatedBy).toBe(SHARED_HUB_USER);
    // …but the two agents are now distinguishable.
    expect(note.createdVia).toBe(`nostr:${PUBKEY_A}`);
    expect(note.lastUpdatedVia).toBe(`nostr:${PUBKEY_B}`);
  });

  it("the signer is FILTERABLE — the created_via value core advertises actually matches", async () => {
    // This is the door-parity assertion: core's manifest tells a cloud client
    // it may filter `created_via: "nostr:<hex>"`. Prove cloud can answer.
    const v = freshVault("nostr-filter");
    const tokenA = await agentToken(v, PUBKEY_A);
    const tokenB = await agentToken(v, PUBKEY_B);

    const byA = await callTool(v, tokenA, "create-note", {
      content: "A wrote this",
      path: "Filter/A",
    });
    await callTool(v, tokenB, "create-note", { content: "B wrote this", path: "Filter/B" });
    await callTool(v, tokenB, "update-note", { id: byA.id, append: " (edited)" });

    const createdByA = await callTool(v, tokenA, "query-notes", {
      created_via: `nostr:${PUBKEY_A}`,
    });
    const aNotes = Array.isArray(createdByA) ? createdByA : createdByA.notes;
    expect(aNotes.map((n: any) => n.path)).toEqual(["Filter/A"]);

    const touchedByB = await callTool(v, tokenA, "query-notes", {
      last_updated_via: `nostr:${PUBKEY_B}`,
    });
    const bNotes = Array.isArray(touchedByB) ? touchedByB : touchedByB.notes;
    expect(bNotes.map((n: any) => n.path).sort()).toEqual(["Filter/A", "Filter/B"]);
  });
});
