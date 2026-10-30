/**
 * Review finding (T-318 day review, reviewer c): the closed check runs BEFORE
 * authentication, so a caller with no credential at all learns that the
 * vault's owner has asked to delete their account.
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { FIRST_PARTY_CLIENT_ID } from "../src/auth.ts";
import { base, createNote, freshVault, mintToken } from "./helpers.ts";

const fp = (v: string) => mintToken({ vault: v, scopes: `vault:${v}:admin`, vaultScope: [v], clientId: FIRST_PARTY_CLIENT_ID });

async function setClosed(v: string, closed: boolean): Promise<Response> {
  return SELF.fetch(`${base(v)}/api/internal/config`, {
    method: "PUT",
    headers: { authorization: `Bearer ${await fp(v)}`, "content-type": "application/json" },
    body: JSON.stringify({ closed }),
  });
}

describe("review c — closed vault doors", () => {
  it("a stranger with NO credential learns nothing about the account's state (generic 401, not account_closed)", async () => {
    const v = freshVault("rc");
    await createNote(v, { content: "x" });
    const before = await SELF.fetch(`${base(v)}/api/notes`);
    expect(before.status).toBe(401);
    const beforeBody = (await before.json()) as any;
    expect((await setClosed(v, true)).status).toBe(200);
    const after = await SELF.fetch(`${base(v)}/api/notes`);
    expect(after.status).toBe(401);
    const afterBody = (await after.json()) as any;
    // Without any credential the response should be the same as for an open vault.
    expect(afterBody).toEqual(beforeBody);
  });
});
