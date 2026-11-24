/**
 * A new person who starts in the Parachute app (T-476). The app's "Sign in with Parachute Cloud" asks for the account
 * door (`account:vaults`) to learn the person's vaults. A new email there makes the account (the emailed sign-in), and
 * then the person has no vault. Before this, the consent page said "create one, then reconnect" and its Allow answered
 * "Invalid request": the app's sign-in ended on an error page with no way back. Now Allow lets the app make the first
 * vault, through the account door's `create-vault`, with the same sign-in.
 *
 * Driven through the real worker the way the app and a browser do it, in production's two-origin shape (the issuer on
 * cloud., the pages on my.): the app registers itself, the sign-in page, the emailed link (read from the dev echo, the
 * one step on the test env, as one-pass-connect.test.ts does), the consent left as rendered, the token at cloud., then
 * `create-vault` and `list-vaults` on the account door. Nothing of Parachute's is stubbed.
 */
import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import worker from "../src/index.ts";
import { makePkce } from "./helpers.ts";

const CLOUD = env.ISSUER.replace(/\/$/, "");
const MY = env.APP_ORIGIN!.replace(/\/$/, "");
const prodEnv = { ...env, ENVIRONMENT: "production" };
const APP_CALLBACK = "http://127.0.0.1:47219/oauth/callback";

/** One browser: host-only cookies per origin. */
function browser() {
  const jar = new Map<string, Map<string, string>>();
  return async (url: string, init: { method?: string; body?: BodyInit; headers?: Record<string, string> } = {}, e: typeof env = prodEnv) => {
    const origin = new URL(url).origin;
    const mine = jar.get(origin) ?? new Map<string, string>();
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (mine.size) headers.cookie = [...mine].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await worker.fetch(new Request(url, { method: init.method ?? "GET", body: init.body, headers, redirect: "manual" }), e);
    for (const c of (res.headers as unknown as { getSetCookie(): string[] }).getSetCookie()) {
      const [pair] = c.split(";");
      const i = pair!.indexOf("=");
      const [k, v] = [pair!.slice(0, i).trim(), pair!.slice(i + 1).trim()];
      if (/max-age=0/i.test(c) || !v) mine.delete(k); else mine.set(k, v);
    }
    jar.set(origin, mine);
    return res;
  };
}

const unescape = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

/** A page's words, as a person reads them. */
const words = (html: string) => unescape(html.replace(/<(style|script)[\s\S]*?<\/\1>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " "));

/** What a browser posts for a form left as rendered: its hidden inputs, checked boxes and radios. */
function asRendered(html: string, action: string): URLSearchParams {
  const form = new RegExp(`<form[^>]*action="${action.replace(/\//g, "\\/")}"[^>]*>([\\s\\S]*?)<\\/form>`).exec(html)?.[1];
  if (!form) throw new Error(`no form posting to ${action}`);
  const out = new URLSearchParams();
  for (const m of form.matchAll(/<input\b([^>]*)>/g)) {
    const a = m[1]!, name = /name="([^"]+)"/.exec(a)?.[1], type = /type="([^"]+)"/.exec(a)?.[1] ?? "text";
    if (!name || type === "text" || type === "email" || type === "password") continue;
    if ((type === "checkbox" || type === "radio") && !/\schecked\b/.test(a)) continue;
    out.set(name, unescape(/value="([^"]*)"/.exec(a)?.[1] ?? "on"));
  }
  const button = /<button[^>]*name="([^"]+)"[^>]*value="approve"/.exec(form);
  if (button) out.set(button[1]!, "approve");
  return out;
}

async function rpc(url: string, token: string, name: string, args: Record<string, unknown>) {
  const res = await worker.fetch(
    new Request(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
    prodEnv,
  );
  const text = await res.text();
  return { status: res.status, text };
}

describe("a new person who starts in the Parachute app", () => {
  test("email → account → Allow → the app makes their first vault with the same sign-in", async () => {
    const browse = browser();
    // the app registers itself, as it does on Cloud (under the name Cloud leaves it)
    const reg = await worker.fetch(
      new Request(`${CLOUD}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "Vault app", redirect_uris: [APP_CALLBACK], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
      }),
      prodEnv,
    );
    expect(reg.status, await reg.clone().text()).toBe(201);
    const clientId = ((await reg.json()) as { client_id: string }).client_id;
    const { verifier, challenge } = await makePkce();
    const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: APP_CALLBACK, code_challenge: challenge, code_challenge_method: "S256", state: "app-state", scope: "account:vaults" });

    // the sign-in page (cloud. sends the browser to my.) says a new email makes the account
    let res = await browse(`${CLOUD}/oauth/authorize?${q}`);
    if (res.status === 302) res = await browse(res.headers.get("location")!);
    const login = await res.text();
    expect(words(login)).toContain("New to Parachute? The same link makes your account.");

    // a new email: the emailed link (dev echo) makes the account and resumes the same request
    const email = `new-${crypto.randomUUID().slice(0, 8)}@example.com`;
    const send = asRendered(login, "/auth/magic");
    send.set("email", email);
    const sent = await browse(`${MY}/auth/magic`, { method: "POST", body: send, headers: { "content-type": "application/x-www-form-urlencoded", origin: MY } }, env);
    const link = sent.headers.get("x-parachute-dev-magic-link");
    expect(link, `send ${sent.status}`).toBeTruthy();
    res = await browse(link!);
    for (let i = 0; i < 4 && res.status >= 300 && res.status < 400; i++) res = await browse(new URL(res.headers.get("location")!, MY).toString());
    const consent = await res.text();
    expect(words(consent)).toContain(`Signed in as ${email}`);
    expect(words(consent)).toContain("You don't have a vault yet. Allow, and Vault app can make your first vault with you.");

    // Allow, as the page is rendered
    const allow = await browse(`${MY}/oauth/authorize`, { method: "POST", body: asRendered(consent, "/oauth/authorize"), headers: { "content-type": "application/x-www-form-urlencoded", origin: MY } });
    const back = allow.headers.get("location") ?? JSON.parse(/location\.replace\(("[^"]+")\)/.exec(await allow.text())?.[1] ?? '""');
    const code = back ? new URL(back).searchParams.get("code") : null;
    expect(code, `allow ${allow.status}`).toBeTruthy();

    // the token, at the issuer, as the app redeems it
    const tok = await worker.fetch(
      new Request(`${CLOUD}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code: code!, code_verifier: verifier, redirect_uri: APP_CALLBACK, client_id: clientId }),
      }),
      prodEnv,
    );
    expect(tok.status, await tok.clone().text()).toBe(200);
    const { access_token, scope } = (await tok.json()) as { access_token: string; scope: string };
    expect(scope).toMatch(/account:[^ ]+:vault-create/);
    expect(scope).toMatch(/account:[^ ]+:vaults:\*:write/);

    // the app makes the first vault with it, and the same token lists it
    const door = ((await (await worker.fetch(new Request(`${CLOUD}/.well-known/parachute-account`), prodEnv)).json()) as { account_mcp_endpoint: string }).account_mcp_endpoint;
    const name = `ines-${crypto.randomUUID().slice(0, 6)}`;
    const made = await rpc(door, access_token, "create-vault", { name });
    expect(made.status, made.text).toBe(200);
    expect(made.text).not.toContain('"isError":true');
    const listed = await rpc(door, access_token, "list-vaults", {});
    expect(listed.text).toContain(name);
  });
});
