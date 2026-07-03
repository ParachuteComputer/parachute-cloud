/**
 * Guided arrival — console first-run, the getting-started checklist, and the
 * Connect-your-AI card (design principles ratified 2026-07-02: the next step
 * is always a door, not a manual; guidance dismissible, never modal-walled;
 * 2FA stays a surfaced option).
 *
 * Covers:
 *   - first-run rendering (zero-vault hero vs has-vault console),
 *   - the two optional research questions: notes_app persisted on the user
 *     row (allowlisted), first_note written INTO the new vault through the
 *     mint seam — including the best-effort contract (a failed/unreachable
 *     vault write never fails vault creation),
 *   - checklist CRUD: doors mark done + redirect, idempotency, dismissal,
 *     CSRF/session/ownership gates,
 *   - the Connect-your-AI card content (Claude steps + MCP URL + copy button
 *     + other-AIs line + CLI footnote),
 *   - the 2FA nudge keyed on TOTP enrollment.
 */
import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import app from "../src/index.ts";
import { validateAccessToken } from "../src/tokens.ts";
import { CSRF, ISSUER, seedSession, seedUser, seedVault } from "./helpers.ts";

const NOTES_APP = "https://notes.parachute.computer";

function post(path: string, fields: Record<string, string>, cookie: string): Request {
  return new Request(`${ISSUER}${path}`, {
    method: "POST",
    body: new URLSearchParams(fields),
    headers: { "content-type": "application/x-www-form-urlencoded", origin: ISSUER, cookie },
  });
}

function sessionCookie(sessionId: string): string {
  return `parachute_id_csrf=${CSRF}; parachute_id_session=${sessionId}`;
}

async function consoleHtml(sessionId: string): Promise<string> {
  const res = await app.fetch(
    new Request(`${ISSUER}/console`, { headers: { cookie: sessionCookie(sessionId) } }),
    env,
  );
  expect(res.status).toBe(200);
  return res.text();
}

async function checklistRow(userId: string, item: string): Promise<{ done_at: string } | null> {
  return env.DB.prepare("SELECT done_at FROM user_checklist WHERE user_id = ? AND item = ?")
    .bind(userId, item)
    .first<{ done_at: string }>();
}

async function notesAppFor(userId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT notes_app FROM users WHERE id = ?")
    .bind(userId)
    .first<{ notes_app: string | null }>();
  return row?.notes_app ?? null;
}

// --- first-run rendering -----------------------------------------------------

describe("console first-run (zero vaults)", () => {
  test("zero vaults → the hero: name input + BOTH optional research questions, no checklist", async () => {
    const { id: userId } = await seedUser("fresh@example.com");
    const html = await consoleHtml(await seedSession(userId));
    expect(html).toContain("Name your vault");
    expect(html).toContain("Create my vault");
    // Research question (a): the landing page's chip set, mirrored.
    expect(html).toContain("What do you take notes in today?");
    for (const label of ["Apple Notes", "Notion", "Obsidian", "Paper", "Nothing yet"]) {
      expect(html).toContain(label);
    }
    // Research question (b).
    expect(html).toContain("What's the first thing you want your AI to remember?");
    expect(html).toContain('name="first_note"');
    // Both marked optional — guidance, never a wall.
    expect(html).toContain("(optional)");
    // No vault yet → no checklist card, no "Your vaults" list header.
    expect(html).not.toContain('data-testid="checklist"');
    expect(html).not.toContain("Your vaults");
  });

  test("with a vault → the normal console: checklist card above vault cards, no research questions", async () => {
    const { id: userId } = await seedUser("settled@example.com");
    await seedVault("homebase", userId);
    const html = await consoleHtml(await seedSession(userId));
    expect(html).toContain("Your vaults");
    expect(html).toContain('data-testid="checklist"');
    expect(html).toContain("Getting started");
    expect(html).not.toContain("What do you take notes in today?");
    expect(html).not.toContain('name="first_note"');
    // The checklist renders ABOVE the vault cards.
    expect(html.indexOf('data-testid="checklist"')).toBeLessThan(html.indexOf('class="vault"'));
  });

  test("a validation error re-renders the hero with the answers preserved", async () => {
    const { id: userId } = await seedUser("preserve@example.com");
    const sessionId = await seedSession(userId);
    const res = await app.fetch(
      post(
        "/console/vaults",
        { __csrf: CSRF, name: "admin", notes_app: "obsidian", first_note: "Remember the garden" },
        sessionCookie(sessionId),
      ),
      env,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("reserved");
    expect(html).toContain("Name your vault"); // still the hero (no vault created)
    expect(html).toContain('value="admin"');
    expect(html).toContain("Remember the garden");
    expect(html).toMatch(/value="obsidian"\s+checked/);
  });
});

// --- first-run create: research answers + the first note ---------------------

describe("first-run create — notes_app + first_note", () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });
  afterEach(() => fetchMock.assertNoPendingInterceptors());

  test("notes_app is persisted on the user row (allowlisted value)", async () => {
    const { id: userId } = await seedUser("research@example.com");
    const sessionId = await seedSession(userId);
    const res = await app.fetch(
      post("/console/vaults", { __csrf: CSRF, name: "research-box", notes_app: "obsidian" }, sessionCookie(sessionId)),
      env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/console?created=research-box");
    expect(await notesAppFor(userId)).toBe("obsidian");
  });

  test("an unknown notes_app value is NOT stored (allowlist), creation still succeeds", async () => {
    const { id: userId } = await seedUser("research2@example.com");
    const sessionId = await seedSession(userId);
    const res = await app.fetch(
      post("/console/vaults", { __csrf: CSRF, name: "research-box2", notes_app: "malware'); DROP--" }, sessionCookie(sessionId)),
      env,
    );
    expect(res.status).toBe(302);
    expect(await notesAppFor(userId)).toBeNull();
  });

  test("first_note is written into the new vault through the mint seam — path, content verbatim, narrow claims", async () => {
    const { id: userId } = await seedUser("firstnote@example.com");
    const sessionId = await seedSession(userId);

    let auth: string | undefined;
    let body: string | undefined;
    fetchMock
      .get(env.VAULT_ORIGIN!)
      .intercept({
        path: "/vault/seedling/api/notes",
        method: "POST",
        headers: (h: Record<string, string>) => {
          auth = h.authorization ?? h.Authorization;
          return true;
        },
        body: (raw: string) => {
          body = raw;
          return true;
        },
      })
      .reply(201, { id: "n1", path: "My first note" }, { headers: { "content-type": "application/json" } });

    const res = await app.fetch(
      post(
        "/console/vaults",
        { __csrf: CSRF, name: "seedling", first_note: "I'm rebuilding my garden this summer" },
        sessionCookie(sessionId),
      ),
      env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/console?created=seedling");

    // The note body: their text VERBATIM at the fixed path.
    expect(JSON.parse(body!)).toEqual({ path: "My first note", content: "I'm rebuilding my garden this summer" });

    // The mint seam, pinned end-to-end (same contract as the packs button):
    // aud-pinned, resource-narrowed write scope, 60s TTL, first-party client.
    const token = auth!.replace(/^Bearer /, "");
    const { payload } = await validateAccessToken(env.DB, token, ISSUER);
    expect(payload.aud).toBe("vault.seedling");
    expect(payload.scope).toBe("vault:seedling:write");
    expect(payload.vault_scope).toEqual(["seedling"]);
    expect(payload.sub).toBe(userId);
    expect(payload.client_id).toBe("parachute-console");
    expect((payload.exp as number) - (payload.iat as number)).toBe(60);
  });

  test("BEST-EFFORT: a failed vault write (500) does not fail vault creation", async () => {
    const { id: userId } = await seedUser("besteffort@example.com");
    const sessionId = await seedSession(userId);
    fetchMock
      .get(env.VAULT_ORIGIN!)
      .intercept({ path: "/vault/resilient/api/notes", method: "POST" })
      .reply(500, { error: "Internal server error" }, { headers: { "content-type": "application/json" } });

    const res = await app.fetch(
      post("/console/vaults", { __csrf: CSRF, name: "resilient", first_note: "still mine" }, sessionCookie(sessionId)),
      env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/console?created=resilient");
    const vault = await env.DB.prepare("SELECT name FROM vaults WHERE name = ?").bind("resilient").first();
    expect(vault).not.toBeNull();
  });

  test("BEST-EFFORT: an UNREACHABLE vault worker does not fail vault creation (logged)", async () => {
    const { id: userId } = await seedUser("unreachable@example.com");
    const sessionId = await seedSession(userId);
    const warn = vi.spyOn(console, "warn");
    // No interceptor + disableNetConnect → the fetch throws; the handler
    // catches, logs, and finishes the redirect anyway.
    const res = await app.fetch(
      post("/console/vaults", { __csrf: CSRF, name: "offline-box", first_note: "note into the void" }, sessionCookie(sessionId)),
      env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/console?created=offline-box");
    expect(warn.mock.calls.some((c) => String(c[0]).includes("event=first_note_write_failed"))).toBe(true);
    warn.mockRestore();
  });

  test("an empty / whitespace first_note makes NO vault call at all", async () => {
    const { id: userId } = await seedUser("nonote@example.com");
    const sessionId = await seedSession(userId);
    const warn = vi.spyOn(console, "warn");
    // disableNetConnect + no interceptor: any attempted call would surface as
    // an event=first_note_write_failed warning. Silence proves no call.
    const res = await app.fetch(
      post("/console/vaults", { __csrf: CSRF, name: "quiet-box", first_note: "   " }, sessionCookie(sessionId)),
      env,
    );
    expect(res.status).toBe(302);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("first_note_write_failed"))).toBe(false);
    warn.mockRestore();
  });
});

// --- checklist CRUD -----------------------------------------------------------

describe("getting-started checklist (POST /console/checklist)", () => {
  async function userWithVault(email: string, vault: string): Promise<{ userId: string; sessionId: string }> {
    const { id: userId } = await seedUser(email);
    await seedVault(vault, userId);
    return { userId, sessionId: await seedSession(userId) };
  }

  test("a door marks its item done and 302s to the notes deep-link", async () => {
    const { userId, sessionId } = await userWithVault("doors@example.com", "doorvault");
    const res = await app.fetch(
      post("/console/checklist", { __csrf: CSRF, item: "open-notes" }, sessionCookie(sessionId)),
      env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      `${NOTES_APP}/?add=${encodeURIComponent("https://u.parachute.computer/vault/doorvault")}`,
    );
    expect(await checklistRow(userId, "open-notes")).not.toBeNull();
    // The console now renders the item as done.
    const html = await consoleHtml(sessionId);
    expect(html).toContain('data-item="open-notes" data-done="1"');
    expect(html).toContain('data-item="write-note" data-done="0"');
  });

  test("write-note → the /new (new-note editor) deep-link; import-notes → the /import deep-link", async () => {
    const { userId, sessionId } = await userWithVault("doors2@example.com", "doorvault2");
    const base = encodeURIComponent("https://u.parachute.computer/vault/doorvault2");

    // write-note carries its own redirect: connect, then land on the new-note
    // editor (notes-ui 0.1.10's redirect fix) — not the notes home.
    const write = await app.fetch(
      post("/console/checklist", { __csrf: CSRF, item: "write-note" }, sessionCookie(sessionId)),
      env,
    );
    expect(write.headers.get("location")).toBe(`${NOTES_APP}/?add=${base}&redirect=%2Fnew`);

    const imp = await app.fetch(
      post("/console/checklist", { __csrf: CSRF, item: "import-notes" }, sessionCookie(sessionId)),
      env,
    );
    expect(imp.headers.get("location")).toBe(`${NOTES_APP}/?add=${base}&redirect=%2Fimport`);
    expect(await checklistRow(userId, "write-note")).not.toBeNull();
    expect(await checklistRow(userId, "import-notes")).not.toBeNull();
  });

  test("expandable items (connect-ai, add-phone) mark done and land back on /console", async () => {
    const { userId, sessionId } = await userWithVault("doors3@example.com", "doorvault3");
    for (const item of ["connect-ai", "add-phone"]) {
      const res = await app.fetch(post("/console/checklist", { __csrf: CSRF, item }, sessionCookie(sessionId)), env);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/console");
      expect(await checklistRow(userId, item)).not.toBeNull();
    }
  });

  test("re-clicking a door is idempotent (original done_at kept)", async () => {
    const { userId, sessionId } = await userWithVault("doors4@example.com", "doorvault4");
    await app.fetch(post("/console/checklist", { __csrf: CSRF, item: "open-notes" }, sessionCookie(sessionId)), env);
    const first = await checklistRow(userId, "open-notes");
    await app.fetch(post("/console/checklist", { __csrf: CSRF, item: "open-notes" }, sessionCookie(sessionId)), env);
    const again = await checklistRow(userId, "open-notes");
    expect(again!.done_at).toBe(first!.done_at);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM user_checklist WHERE user_id = ?")
      .bind(userId)
      .first<{ n: number }>();
    expect(count!.n).toBe(1);
  });

  test("an unknown item is refused (no row)", async () => {
    const { userId, sessionId } = await userWithVault("doors5@example.com", "doorvault5");
    const res = await app.fetch(
      post("/console/checklist", { __csrf: CSRF, item: "rm-rf-everything" }, sessionCookie(sessionId)),
      env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/console");
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM user_checklist WHERE user_id = ?")
      .bind(userId)
      .first<{ n: number }>();
    expect(count!.n).toBe(0);
  });

  test("'hide this' dismisses the whole card, persisted; done rows survive", async () => {
    const { userId, sessionId } = await userWithVault("dismiss@example.com", "dismissvault");
    await app.fetch(post("/console/checklist", { __csrf: CSRF, item: "open-notes" }, sessionCookie(sessionId)), env);
    const res = await app.fetch(
      post("/console/checklist", { __csrf: CSRF, item: "hidden" }, sessionCookie(sessionId)),
      env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/console");
    const html = await consoleHtml(sessionId);
    expect(html).not.toContain('data-testid="checklist"');
    expect(html).not.toContain("Getting started");
    // Vault cards still render — dismissing guidance never removes function.
    expect(html).toContain("dismissvault");
    expect(await checklistRow(userId, "open-notes")).not.toBeNull();
  });

  test("dismiss → the quiet 'Show setup guide' footer link; restore brings the card back, progress intact", async () => {
    const { userId, sessionId } = await userWithVault("restore@example.com", "restorevault");
    await app.fetch(post("/console/checklist", { __csrf: CSRF, item: "open-notes" }, sessionCookie(sessionId)), env);

    // While the card shows, there is no restore link.
    expect(await consoleHtml(sessionId)).not.toContain('data-testid="show-setup-guide"');

    // Dismiss → card gone, the footer link appears.
    await app.fetch(post("/console/checklist", { __csrf: CSRF, item: "hidden" }, sessionCookie(sessionId)), env);
    const hiddenHtml = await consoleHtml(sessionId);
    expect(hiddenHtml).not.toContain('data-testid="checklist"');
    expect(hiddenHtml).toContain('data-testid="show-setup-guide"');
    expect(hiddenHtml).toContain("Show setup guide");
    expect(hiddenHtml).toContain('action="/console/checklist/restore"');

    // Restore (CSRF POST deleting the hidden row) → 302 back to the console.
    const res = await app.fetch(post("/console/checklist/restore", { __csrf: CSRF }, sessionCookie(sessionId)), env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/console");
    expect(await checklistRow(userId, "hidden")).toBeNull(); // the row is DELETED
    const backHtml = await consoleHtml(sessionId);
    expect(backHtml).toContain('data-testid="checklist"');
    expect(backHtml).toContain('data-item="open-notes" data-done="1"'); // progress survived the round-trip
    expect(backHtml).not.toContain('data-testid="show-setup-guide"');
  });

  test("restore requires CSRF + session (same trust boundary as every console write)", async () => {
    const { userId, sessionId } = await userWithVault("restore2@example.com", "restorevault2");
    await app.fetch(post("/console/checklist", { __csrf: CSRF, item: "hidden" }, sessionCookie(sessionId)), env);

    // Missing CSRF → refused; the card stays hidden.
    const noCsrf = await app.fetch(
      new Request(`${ISSUER}/console/checklist/restore`, {
        method: "POST",
        body: new URLSearchParams({}),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: ISSUER,
          cookie: `parachute_id_session=${sessionId}`,
        },
      }),
      env,
    );
    expect(noCsrf.status).toBe(200);
    expect(await noCsrf.text()).toContain("session expired");
    expect(await checklistRow(userId, "hidden")).not.toBeNull();

    // No session → /login.
    const anon = await app.fetch(post("/console/checklist/restore", { __csrf: CSRF }, `parachute_id_csrf=${CSRF}`), env);
    expect(anon.status).toBe(302);
    expect(anon.headers.get("location")).toBe("/login");
  });

  test("CSRF is required; a sessionless POST redirects to /login", async () => {
    const { userId, sessionId } = await userWithVault("csrf@example.com", "csrfvault");
    // Missing CSRF field/cookie mismatch → refused, no row.
    const noCsrf = await app.fetch(
      new Request(`${ISSUER}/console/checklist`, {
        method: "POST",
        body: new URLSearchParams({ item: "open-notes" }),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: ISSUER,
          cookie: `parachute_id_session=${sessionId}`,
        },
      }),
      env,
    );
    expect(noCsrf.status).toBe(200);
    expect(await noCsrf.text()).toContain("session expired");
    expect(await checklistRow(userId, "open-notes")).toBeNull();

    const anon = await app.fetch(
      post("/console/checklist", { __csrf: CSRF, item: "open-notes" }, `parachute_id_csrf=${CSRF}`),
      env,
    );
    expect(anon.status).toBe(302);
    expect(anon.headers.get("location")).toBe("/login");
  });

  test("zero vaults → a door records nothing and returns to /console", async () => {
    const { id: userId } = await seedUser("novault@example.com");
    const sessionId = await seedSession(userId);
    const res = await app.fetch(
      post("/console/checklist", { __csrf: CSRF, item: "open-notes" }, sessionCookie(sessionId)),
      env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/console");
    expect(await checklistRow(userId, "open-notes")).toBeNull();
  });
});

// --- the Connect-your-AI card -------------------------------------------------

describe("Connect-your-AI card", () => {
  test("renders the Claude walkthrough, the MCP URL with a copy button, the other-AIs line, and the CLI footnote", async () => {
    const { id: userId } = await seedUser("connect@example.com");
    await seedVault("connectme", userId);
    const html = await consoleHtml(await seedSession(userId));
    const mcpUrl = "https://u.parachute.computer/vault/connectme/mcp";
    // Numbered Claude-first steps.
    expect(html).toContain("claude.ai");
    expect(html).toContain("Settings → Connectors");
    expect(html).toContain("Add custom connector");
    // The MCP URL, shown AND wired to the copy button.
    expect(html).toContain(`<pre>${mcpUrl}</pre>`);
    expect(html).toContain(`data-copy="${mcpUrl}"`);
    // Other AIs + the nerd footnote.
    expect(html).toContain("Other AIs:");
    expect(html).toContain(`claude mcp add --transport http parachute-connectme ${mcpUrl}`);
    // Present in BOTH the checklist expansion and the vault card disclosure.
    expect(html).toContain('data-check="connect-ai"');
    expect((html.match(/Add custom connector/g) ?? []).length).toBe(2);
    // The console page carries the copy/mark script.
    expect(html).toContain("navigator.clipboard.writeText");
  });
});

// --- the 2FA nudge --------------------------------------------------------------

describe("2FA nudge (checklist footer)", () => {
  test("not enrolled → the quiet add-2FA line links /console/security", async () => {
    const { id: userId } = await seedUser("nudge@example.com");
    await seedVault("nudgevault", userId);
    const html = await consoleHtml(await seedSession(userId));
    expect(html).toContain("Secure your account:");
    expect(html).toContain('href="/console/security"');
  });

  test("enrolled → the nudge is gone (the checklist card remains)", async () => {
    const { id: userId } = await seedUser("enrolled@example.com");
    await seedVault("enrolledvault", userId);
    await env.DB.prepare("UPDATE users SET totp_secret = ?, totp_enrolled_at = ? WHERE id = ?")
      .bind("JBSWY3DPEHPK3PXP", new Date().toISOString(), userId)
      .run();
    const html = await consoleHtml(await seedSession(userId));
    expect(html).not.toContain("Secure your account:");
    expect(html).toContain('data-testid="checklist"');
  });

  test("dismissing the card dismisses the nudge with it", async () => {
    const { id: userId } = await seedUser("nudgegone@example.com");
    await seedVault("nudgegonevault", userId);
    const sessionId = await seedSession(userId);
    await app.fetch(post("/console/checklist", { __csrf: CSRF, item: "hidden" }, sessionCookie(sessionId)), env);
    const html = await consoleHtml(sessionId);
    expect(html).not.toContain("Secure your account:");
  });
});
