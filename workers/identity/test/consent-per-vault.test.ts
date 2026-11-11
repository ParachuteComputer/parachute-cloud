/**
 * Consent per vault on the account door (Parachute 0.9.1 "one multi-vault door", T-446), and "Connect says what it
 * reads". An app asks for the account door (`scope=account:vaults`); the person sets each vault to none, read or write
 * on the consent screen (`account_vault_levels=1`, one `vault_level:<vault>` per vault — the field names the box's
 * door contract posts). The token carries exactly that: `account:<id>:vaults:<v>:<level>` per chosen vault.
 *
 *   - a posted level above write, a vault that isn't the person's, a vault name holding `:`, or every vault at none
 *     gives no code;
 *   - the app can't choose a vault or level itself through the scopes it asks for;
 *   - a later per-vault consent REPLACES the same app's earlier one (never a union), and the earlier refresh token
 *     can't bring the wider levels back;
 *   - the consent screen says in plain words what the connection can read, never less than the grant allows.
 *
 * Real D1, the real authorize / token handlers; nothing of Parachute's is stubbed.
 */
import { describe, expect, test } from "vitest";
import { handleAuthorizeGet, handleAuthorizePost } from "../src/oauth-authorize.ts";
import { handleToken } from "../src/oauth-token.ts";
import {
  REDIRECT_URI,
  authorizeGetReq,
  bridgeTarget,
  consentReq,
  db,
  deps,
  makePkce,
  seedApprovedClient,
  seedSession,
  seedUser,
  seedVault,
  tokenReq,
} from "./helpers.ts";

async function person() {
  const { id } = await seedUser(`mara-${crypto.randomUUID().slice(0, 8)}@example.com`);
  const tag = crypto.randomUUID().slice(0, 6);
  const v = { A: `fern-${tag}`, B: `bake-${tag}`, C: `till-${tag}` };
  for (const name of Object.values(v)) await seedVault(name, id);
  return { id, sessionId: await seedSession(id), ...v };
}

type Outcome = { code: string | null; status: number; location: string | null; verifier: string; q: Record<string, string> };

/** Ask for the account door as `clientId`, then post the consent form with `form`. */
async function consent(sessionId: string, clientId: string, form: Record<string, string>, scope = "account:vaults"): Promise<Outcome> {
  const { verifier, challenge } = await makePkce();
  const q = { client_id: clientId, redirect_uri: REDIRECT_URI, response_type: "code", scope, code_challenge: challenge, code_challenge_method: "S256", state: "s" };
  await handleAuthorizeGet(db(), authorizeGetReq(q, sessionId), deps());
  const res = await handleAuthorizePost(db(), consentReq({ ...q, ...form }, { sessionId }), deps());
  const location = res.headers.get("location") ?? (res.status === 200 ? bridgeTarget(await res.clone().text()) : null);
  const code = location ? new URL(location).searchParams.get("code") : null;
  return { code, status: res.status, location, verifier, q };
}

async function redeem(o: Outcome): Promise<{ access_token: string; refresh_token: string; scope: string }> {
  const res = await handleToken(db(), tokenReq({ grant_type: "authorization_code", code: o.code!, client_id: o.q.client_id!, redirect_uri: REDIRECT_URI, code_verifier: o.verifier }), deps());
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as { access_token: string; refresh_token: string; scope: string };
}

const levels = (m: Record<string, string>) => ({ account_vault_levels: "1", ...Object.fromEntries(Object.entries(m).map(([v, l]) => [`vault_level:${v}`, l])) });
const sorted = (scope: string) => scope.split(" ").sort();

describe("consent per vault on the account door", () => {
  test("A read, B write, C none: the token carries exactly those levels", async () => {
    const p = await person();
    const { clientId } = await seedApprovedClient({ clientName: "Fernhill Portal" });
    const o = await consent(p.sessionId, clientId, levels({ [p.A]: "read", [p.B]: "write", [p.C]: "none" }));
    expect(o.code, `${o.status} ${o.location}`).toBeTruthy();
    const t = await redeem(o);
    expect(sorted(t.scope)).toEqual([`account:${p.id}:vaults:${p.A}:read`, `account:${p.id}:vaults:${p.B}:write`].sort());
  });

  test("the page's own defaults: picking \"only\" and \"Read only\" grants read, never write (review r1)", async () => {
    const p = await person();
    const { clientId } = await seedApprovedClient();
    const { challenge } = await makePkce();
    const q = { client_id: clientId, redirect_uri: REDIRECT_URI, response_type: "code", scope: "account:vaults", code_challenge: challenge, code_challenge_method: "S256", state: "s" };
    const html = await (await handleAuthorizeGet(db(), authorizeGetReq(q, p.sessionId), deps())).text();
    // What a browser posts for each select left as rendered.
    const defaults = Object.fromEntries(
      [...html.matchAll(/<select name="(vault_level:[^"]+)"[^>]*>([\s\S]*?)<\/select>/g)].map((m) => [m[1]!, /<option value="([^"]+)" selected/.exec(m[2]!)?.[1] ?? /<option value="([^"]+)"/.exec(m[2]!)![1]!]),
    );
    const o = await consent(p.sessionId, clientId, { ...defaults, account_vault_levels: "1", vault_mode: "specific", access_verb: "read" });
    expect(o.code).toBeTruthy();
    expect((await redeem(o)).scope).not.toContain(":write");
    // Even with a select set to write, the "Read only" radio caps it.
    const capped = await consent(p.sessionId, clientId, { ...levels({ [p.A]: "write" }), vault_mode: "specific", access_verb: "read" });
    expect((await redeem(capped)).scope).toBe(`account:${p.id}:vaults:${p.A}:read`);
  });

  test("above write, someone else's vault, a name holding ':' or every vault at none: no code", async () => {
    const p = await person();
    const { id: other } = await seedUser(`client-42-${crypto.randomUUID().slice(0, 6)}@example.com`);
    const theirs = `theirs-${crypto.randomUUID().slice(0, 6)}`;
    await seedVault(theirs, other);
    const { clientId } = await seedApprovedClient();
    const tries: Record<string, Record<string, string>> = {
      admin: levels({ [p.A]: "admin" }),
      unknown: levels({ [p.A]: "read", "nope-vault-x": "read" }),
      theirs: levels({ [p.A]: "read", [theirs]: "read" }),
      colon: levels({ [`${p.A}:write`]: "read" }),
      levelLike: levels({ write: "read" }),
      allNone: levels({ [p.A]: "none", [p.B]: "none" }),
      nothing: { account_vault_levels: "1" },
    };
    for (const [why, form] of Object.entries(tries)) {
      const o = await consent(p.sessionId, clientId, form);
      expect(o.code, why).toBeNull();
    }
  });

  test("the app can't choose a vault or a level through the scopes it asks for", async () => {
    const p = await person();
    const { clientId } = await seedApprovedClient();
    for (const scope of [
      `account:vaults account:${p.id}:vaults:${p.B}:write`,
      `account:${p.id}:vaults:${p.B}:write`,
      `account:${p.id}:vaults:*:write`,
    ]) {
      const o = await consent(p.sessionId, clientId, levels({ [p.A]: "read" }), scope);
      if (o.code) expect((await redeem(o)).scope, scope).not.toContain(p.B);
    }
  });

  test("a later per-vault consent replaces the earlier one for that app, and the old refresh token can't widen it", async () => {
    const p = await person();
    const { clientId } = await seedApprovedClient();
    const first = await redeem(await consent(p.sessionId, clientId, levels({ [p.A]: "write", [p.B]: "write" })));
    expect(sorted(first.scope)).toEqual([`account:${p.id}:vaults:${p.A}:write`, `account:${p.id}:vaults:${p.B}:write`].sort());
    const second = await redeem(await consent(p.sessionId, clientId, levels({ [p.A]: "read" })));
    expect(second.scope).toBe(`account:${p.id}:vaults:${p.A}:read`);

    // The refresh token from the first consent: refused, or never more than the second consent allows.
    const res = await handleToken(db(), tokenReq({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: clientId }), deps());
    // This door refuses it outright: the replaced grant's refresh family is gone.
    expect(res.status, await res.clone().text()).toBe(400);
  });
});

describe("Connect says what it reads", () => {
  test("the account consent screen says, per vault, what the connection reads (snapshot)", async () => {
    const p = await person();
    const { clientId } = await seedApprovedClient({ clientName: "Fernhill Portal" });
    const { challenge } = await makePkce();
    const q = { client_id: clientId, redirect_uri: REDIRECT_URI, response_type: "code", scope: "account:vaults", code_challenge: challenge, code_challenge_method: "S256", state: "s" };
    const html = await (await handleAuthorizeGet(db(), authorizeGetReq(q, p.sessionId), deps())).text();
    const start = html.indexOf('data-testid="account-vaults"');
    const block = html.slice(start, html.indexOf("</p>", html.indexOf('data-testid="account-vaults-reads"')));
    expect(block).toContain(`name="vault_level:${p.A}"`);
    expect(html).toContain('name="account_vault_levels" value="1"');
    const text = block
      .replace(/<option[^>]*>[^<]*<\/option>/g, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(new RegExp(`${p.A}|${p.B}|${p.C}`, "g"), "<vault>")
      .replace(/\s+/g, " ")
      .trim();
    expect(text).toMatchInlineSnapshot(`"data-testid="account-vaults"> What this connection can do See the vaults in this connection Listing your vaults is part of connecting — always included. Create new vaults Let this app create new vaults in your account. Uncheck to withhold. Which vaults Any vault — current and future Every vault you own now, plus any you create later, at the access level below. Only the vaults you choose, each at its own level None, read or read & write for each (never above the access level below). A vault you create later won&#39;t be part of this connection until you reconnect. <vault> <vault> <vault> Access level Read only Read the whole vault: every note, tag and attachment, and its settings. Read & write Read the whole vault, and create, edit and delete its notes, tags and attachments. Read means the whole vault: every note, tag and attachment, and its settings. Read & write reads the whole vault too. What this app reads from your vaults goes to the company that runs it."`);
    expect(html).toContain("What this app reads from your vaults goes to the company that runs it.");
  });

  test("a vault's read and write rows say they read the whole vault", async () => {
    const p = await person();
    const { clientId } = await seedApprovedClient();
    const { challenge } = await makePkce();
    const q = { client_id: clientId, redirect_uri: REDIRECT_URI, response_type: "code", scope: `vault:${p.A}:read vault:${p.A}:write`, code_challenge: challenge, code_challenge_method: "S256", state: "s" };
    const html = await (await handleAuthorizeGet(db(), authorizeGetReq(q, p.sessionId), deps())).text();
    const list = (html.match(/<ul class="scopes">([\s\S]*?)<\/ul>/)?.[1] ?? "").replace(new RegExp(p.A, "g"), "<vault>");
    expect(list).toContain("Read the whole vault <vault>: every note, tag and attachment, and its settings");
    expect(list).toContain("Read the whole vault <vault>, and create, edit and delete its notes, tags and attachments");
    expect(html).toContain("What this app reads from your vault goes to the company that runs it.");
  });
});
