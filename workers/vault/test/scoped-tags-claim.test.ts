/**
 * `permissions.scoped_tags` — the cloud door's fail-closed half (cloud#278).
 *
 * Before this change `authenticateVaultToken` hardcoded `scoped_tags: null`
 * (`src/auth.ts`), so a token that asked to see ONLY `#work` was served the
 * WHOLE vault, silently. That was safe only under "no token carries
 * `permissions`" — which no current deployment can break: `ALLOWED_ISSUERS`
 * widens the accepted `iss` set, but `getGuard` fetches JWKS from
 * ISSUER_ORIGIN alone, so a hub-issued token cannot verify here (see
 * `allowed-issuers.test.ts`). The refusal is DEFENSE IN DEPTH, reachable only
 * by a deployment that points ISSUER_ORIGIN at a hub.
 *
 * The parser is a port of the bun vault's `parseScopedTagsFromPermissions`
 * (`parachute-vault/src/auth.ts`) with the same three outcomes. The RUNTIME
 * answer differs by necessity: bun ENFORCES an allowlist (`src/tag-scope.ts`),
 * cloud's `rest/tag-scope.ts` is a documented stub that no caller can reach a
 * non-null branch of, so cloud REFUSES a scoped token instead of pretending.
 * Widening is the one outcome that is never acceptable.
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MalformedScopedTagsError, parseScopedTagsFromPermissions } from "../src/auth.ts";
import { base, freshVault, mintToken, OP } from "./helpers.ts";
import { WS_CLOSE } from "../src/live/ws-subscribe.ts";

function get(vault: string, token: string, path = "/api/notes"): Promise<Response> {
  return SELF.fetch(`${base(vault)}${path}`, { headers: { Authorization: `Bearer ${token}` } });
}

/**
 * TWO vaults for the whole file, not one per test. Every `freshVault` name is a
 * distinct `idFromName` → a distinct live Durable Object in the shared vitest
 * runtime, and the pool evicts DOs under memory pressure — which breaks
 * `embedding-do.test.ts`, whose stub provider lives on a DO INSTANCE
 * (`__setTestEmbeddingProvider`) and vanishes with it (its semantic query then
 * 503s `semantic_unavailable`). Nothing here needs isolation: the refusal cases
 * are rejected at auth and never touch vault state, and the acceptance cases
 * are reads.
 */
const REFUSED = freshVault("scoped-refuse");
const ACCEPTED = freshVault("scoped-ok");

/**
 * Open a live-query socket and return its first close frame. The minimal slice
 * of `ws-subscribe.test.ts`'s client helper — this file only ever needs the
 * close code, never a message.
 */
async function wsAuthClose(vault: string, token: string): Promise<{ code: number; reason: string }> {
  const res = await SELF.fetch(`${base(vault)}/api/subscribe?tag=work`, {
    headers: { Upgrade: "websocket" },
  });
  if (res.status !== 101) throw new Error(`upgrade -> ${res.status}: ${await res.text()}`);
  const ws = res.webSocket!;
  ws.accept();
  const closed = new Promise<{ code: number; reason: string }>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("ws close timeout")), 15000);
    ws.addEventListener("close", (e: any) => {
      clearTimeout(t);
      resolve({ code: e.code, reason: e.reason });
    });
  });
  ws.send(JSON.stringify({ type: "auth", token }));
  return closed;
}

describe("parseScopedTagsFromPermissions — bun parity, fail closed", () => {
  it("ABSENT ⇒ unscoped (null): no permissions, no key, or an explicit null", () => {
    expect(parseScopedTagsFromPermissions(undefined)).toBeNull();
    expect(parseScopedTagsFromPermissions({})).toBeNull();
    expect(parseScopedTagsFromPermissions({ principal_pubkey: "a".repeat(64) })).toBeNull();
    expect(parseScopedTagsFromPermissions({ scoped_tags: null })).toBeNull();
    expect(parseScopedTagsFromPermissions({ scoped_tags: undefined })).toBeNull();
  });

  it("PRESENT and well-formed ⇒ the allowlist, verbatim", () => {
    expect(parseScopedTagsFromPermissions({ scoped_tags: ["work"] })).toEqual(["work"]);
    expect(parseScopedTagsFromPermissions({ scoped_tags: ["work", "life"] })).toEqual([
      "work",
      "life",
    ]);
  });

  it("PRESENT and malformed ⇒ throws; NEVER coerced to null or []", () => {
    // `[]` and `null` are the two coercions that would WIDEN: cloud's
    // `rest/tag-scope.ts` helpers read both as "unscoped = every note".
    for (const raw of [[], "work", 7, {}, ["work", ""], ["work", 3], ["work", null], true]) {
      expect(() => parseScopedTagsFromPermissions({ scoped_tags: raw })).toThrow(
        MalformedScopedTagsError,
      );
    }
  });

  it("reads `scoped_tags` independently of `principal_pubkey` on the same object", () => {
    // The two claims share one `permissions` object on the wire, so a future
    // emitter must MERGE. Neither parser may disturb the other's key.
    const permissions = { principal_pubkey: "a".repeat(64), scoped_tags: ["work"] };
    expect(parseScopedTagsFromPermissions(permissions)).toEqual(["work"]);
  });
});

describe("cloud door — a tag-scoped token is refused, not silently widened", () => {
  it("REGRESSION: a token scoped to one tag does NOT get the whole vault", async () => {
    const v = REFUSED;
    // Seed two notes through the operator bearer; only one is in scope.
    for (const [content, tags] of [
      ["in scope", ["work"]],
      ["out of scope", ["secret"]],
    ] as const) {
      const res = await SELF.fetch(`${base(v)}/api/notes`, {
        method: "POST",
        headers: { Authorization: `Bearer ${OP}`, "Content-Type": "application/json" },
        body: JSON.stringify({ content, tags }),
      });
      expect(res.status).toBe(201);
    }

    const token = await mintToken({
      vault: v,
      scopes: `vault:${v}:read`,
      permissions: { scoped_tags: ["work"] },
    });
    const res = await get(v, token);

    // The bug this pins: a 200 here would mean the `secret` note was served to
    // a token that asked not to see it.
    expect(res.status).toBe(401);
    const body = (await res.json()) as any;
    expect(body.message).toBe("token is tag-scoped, which this vault does not support");
    expect(JSON.stringify(body)).not.toContain("out of scope");
  });

  it("a MALFORMED tag-scope claim is a 401 with the bun door's message", async () => {
    const v = REFUSED;
    const token = await mintToken({
      vault: v,
      scopes: `vault:${v}:read`,
      permissions: { scoped_tags: [] }, // empty array = the widening trap
    });
    const res = await get(v, token);
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).message).toBe("token has a malformed tag-scope claim");
  });

  it("the refusal covers the MCP door too, not just REST", async () => {
    const v = REFUSED;
    const token = await mintToken({
      vault: v,
      scopes: `vault:${v}:read vault:${v}:write`,
      permissions: { scoped_tags: ["work"] },
    });
    const res = await SELF.fetch(`${base(v)}/mcp`, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(401);
  });

  it("the refusal covers the WS door too — `authenticateVaultToken` is the third door", async () => {
    // `vault-do.ts` authenticates a live-query socket's first `auth` message
    // through the same function (`authenticatePendingSocket`, and again on
    // re-auth in `reauthReadySocket`), closing 4401 on any !ok result. Without
    // this, a scoped token refused at REST and MCP could still have opened a
    // full-vault live subscription.
    const v = REFUSED;
    const token = await mintToken({
      vault: v,
      scopes: `vault:${v}:read`,
      permissions: { scoped_tags: ["work"] },
    });
    const close = await wsAuthClose(v, token);
    expect(close.code).toBe(WS_CLOSE.UNAUTHORIZED);
  });
});

describe("no regression for the tokens cloud actually issues", () => {
  it("a token with no `permissions` claim reads normally", async () => {
    const v = ACCEPTED;
    const token = await mintToken({ vault: v, scopes: `vault:${v}:read` });
    expect((await get(v, token)).status).toBe(200);
  });

  it("a token carrying ONLY `principal_pubkey` reads normally (cloud#277 path intact)", async () => {
    const v = ACCEPTED;
    const token = await mintToken({
      vault: v,
      scopes: `vault:${v}:read`,
      permissions: { principal_pubkey: "a".repeat(64) },
    });
    expect((await get(v, token)).status).toBe(200);
  });

  it("an explicit `scoped_tags: null` is unscoped, not a refusal", async () => {
    const v = ACCEPTED;
    const token = await mintToken({
      vault: v,
      scopes: `vault:${v}:read`,
      permissions: { scoped_tags: null },
    });
    expect((await get(v, token)).status).toBe(200);
  });

  it("the operator bearer is unaffected — it is not a JWT and carries no claims", async () => {
    const v = ACCEPTED;
    const res = await SELF.fetch(`${base(v)}/api/notes`, {
      headers: { Authorization: `Bearer ${OP}` },
    });
    expect(res.status).toBe(200);
  });
});
