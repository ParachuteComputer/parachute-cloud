/**
 * Guided arrival — console first-run, the getting-started checklist, and the
 * Connect-your-AI card (design principles ratified 2026-07-02: the next step
 * is always a door, not a manual; guidance dismissible, never modal-walled;
 * 2FA stays a surfaced option).
 *
 * Covers:
 *   - first-run rendering (zero-vault hero vs has-vault console),
 *   - create lands the user straight in the vault's Notes UI (303), with the
 *     old first-run prompts gone and legacy notes_app/first_note fields
 *     tolerated (ignored, never a 400),
 *   - checklist CRUD: doors mark done + redirect, idempotency, dismissal,
 *     CSRF/session/ownership gates,
 *   - the Connect-your-AI card content (Claude steps + MCP URL + copy button
 *     + other-AIs line + CLI footnote),
 *   - the 2FA nudge keyed on TOTP enrollment.
 */
import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import app from "../src/index.ts";
import { CSRF, ISSUER, seedSession, seedUser, seedVault } from "./helpers.ts";

// The app deep-link origin — the wrangler-configured APP_ORIGIN (#116).
const APP_ORIGIN = "https://app.parachute.computer";

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
  test("zero vaults → the hero: just the name input, no research questions, no checklist", async () => {
    const { id: userId } = await seedUser("fresh@example.com");
    const html = await consoleHtml(await seedSession(userId));
    expect(html).toContain("Name your vault");
    expect(html).toContain("Create my vault");
    // The two old research prompts are GONE — creating a vault lands you in
    // your notes, so nothing stands between the name and the door.
    expect(html).not.toContain("What do you take notes in today?");
    expect(html).not.toContain("What's the first thing you want your AI to remember?");
    expect(html).not.toContain('name="first_note"');
    expect(html).not.toContain('name="notes_app"');
    // No vault yet → no checklist card, no "Your vaults" list header.
    expect(html).not.toContain('data-testid="checklist"');
    expect(html).not.toContain("Your vaults");
    // FIX 1: the plan cards now render BELOW the hero so the header trial
    // banner's "Change plan" (#plans) link resolves + a fresh user can pick a
    // tier — before this the zero-vault screen linked to a #plans that never was.
    expect(html).toContain('data-testid="plans"');
    expect(html.indexOf("Create my vault")).toBeLessThan(html.indexOf('data-testid="plans"'));
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
    // FIX 4: the plan cards (pricing) sit BELOW the vault cards — product above
    // the upsell.
    expect(html.indexOf('class="vault"')).toBeLessThan(html.indexOf('data-testid="plans"'));
  });

  test("a validation error re-renders the hero with the name preserved; legacy fields are ignored", async () => {
    const { id: userId } = await seedUser("preserve@example.com");
    const sessionId = await seedSession(userId);
    // A legacy client still POSTs the old optional fields — they must not 400.
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
    expect(html).toContain('value="admin"'); // the entered name is preserved
    // The removed prompts don't come back on re-render.
    expect(html).not.toContain("Remember the garden");
    expect(html).not.toContain('name="notes_app"');
  });
});

// --- first-run create: research answers + the first note ---------------------

describe("first-run create — lands in Notes, tolerant of legacy fields", () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });
  afterEach(() => fetchMock.assertNoPendingInterceptors());

  // The only vault call at create is the best-effort plan-cap push
  // (PUT /api/internal/config). Stub it so the create path completes; the
  // redirect target is what these tests pin.
  function stubCapPush(vaultName: string): void {
    fetchMock
      .get(env.VAULT_ORIGIN!)
      .intercept({ path: `/vault/${vaultName}/api/internal/config`, method: "PUT" })
      .reply(200, { name: vaultName }, { headers: { "content-type": "application/json" } });
  }

  function notesDeepLink(vaultName: string): string {
    return `${APP_ORIGIN}/?add=${encodeURIComponent(`https://u.parachute.computer/vault/${vaultName}`)}`;
  }

  test("a fresh create redirects (303) straight to the new vault's Notes UI", async () => {
    const { id: userId } = await seedUser("landing@example.com");
    const sessionId = await seedSession(userId);
    stubCapPush("landing-box");
    const res = await app.fetch(
      post("/console/vaults", { __csrf: CSRF, name: "landing-box" }, sessionCookie(sessionId)),
      env,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(notesDeepLink("landing-box"));
  });

  test("legacy notes_app + first_note fields are ignored — not stored, no note written, still lands in Notes", async () => {
    const { id: userId } = await seedUser("legacy@example.com");
    const sessionId = await seedSession(userId);
    const warn = vi.spyOn(console, "warn");
    stubCapPush("legacy-box");
    // An old client still POSTs the removed optional fields. The handler never
    // reads them: no 400, notes_app not persisted, and (with no /api/notes
    // interceptor + disableNetConnect) any attempted first-note write would
    // throw → warn — its silence proves no write was attempted.
    const res = await app.fetch(
      post(
        "/console/vaults",
        { __csrf: CSRF, name: "legacy-box", notes_app: "obsidian", first_note: "old client note" },
        sessionCookie(sessionId),
      ),
      env,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(notesDeepLink("legacy-box"));
    expect(await notesAppFor(userId)).toBeNull();
    expect(warn.mock.calls.some((c) => String(c[0]).includes("first_note_write_failed"))).toBe(false);
    warn.mockRestore();
  });
});

// --- the vault-creation moment (Phase 3) -------------------------------------

describe("the vault-creation moment — renders the building→ready JS", () => {
  test("the create-form moment JS rides the zero-vault hero (was has-vault-only)", async () => {
    const { id: userId } = await seedUser("moment-hero@example.com");
    const html = await consoleHtml(await seedSession(userId));
    // The consoleScript now ships on the first-run page so the hero create form
    // gets the beat too — its wiring + the "Preparing…" copy are inline.
    expect(html).toContain("wireCreate");
    expect(html).toContain('form[action="/console/vaults"]');
    expect(html).toContain("Preparing your vault");
    expect(html).toContain("Your vault is ready");
    // The moment's CSS is present (the pulse + reduced-motion honesty).
    expect(html).toContain(".creating-orb");
    expect(html).toContain("prefers-reduced-motion");
  });

  test("the moment JS is also wired on the has-vault console (create-another card)", async () => {
    const { id: userId } = await seedUser("moment-has@example.com");
    await seedVault("already-here", userId);
    const html = await consoleHtml(await seedSession(userId));
    expect(html).toContain("wireCreate");
  });
});

describe("create-vault — the progressive-enhancement JSON variant", () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });
  afterEach(() => fetchMock.assertNoPendingInterceptors());

  function stubCapPush(vaultName: string): void {
    fetchMock
      .get(env.VAULT_ORIGIN!)
      .intercept({ path: `/vault/${vaultName}/api/internal/config`, method: "PUT" })
      .reply(200, { name: vaultName }, { headers: { "content-type": "application/json" } });
  }

  function notesDeepLink(vaultName: string): string {
    return `${APP_ORIGIN}/?add=${encodeURIComponent(`https://u.parachute.computer/vault/${vaultName}`)}`;
  }

  /** A create POST marked as a fetch (the create-form JS path) — via the
   *  `X-Requested-With: fetch` header the JS sets, or an explicit Accept. */
  function fetchCreate(
    fields: Record<string, string>,
    cookie: string,
    signal: "xrw" | "accept" = "xrw",
  ): Request {
    const headers: Record<string, string> = {
      "content-type": "application/x-www-form-urlencoded",
      origin: ISSUER,
      cookie,
    };
    if (signal === "xrw") headers["x-requested-with"] = "fetch";
    else headers["accept"] = "application/json";
    return new Request(`${ISSUER}/console/vaults`, {
      method: "POST",
      body: new URLSearchParams(fields),
      headers,
    });
  }

  test("X-Requested-With: fetch → 200 JSON { redirect } (not the cross-origin 303)", async () => {
    const { id: userId } = await seedUser("moment-xrw@example.com");
    const sessionId = await seedSession(userId);
    stubCapPush("moment-box");
    const res = await app.fetch(fetchCreate({ __csrf: CSRF, name: "moment-box" }, sessionCookie(sessionId)), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { redirect?: string };
    expect(body.redirect).toBe(notesDeepLink("moment-box"));
    // Not a dry run — the vault really is created (the JS then navigates to it).
    const row = await env.DB.prepare("SELECT name FROM vaults WHERE name = ?").bind("moment-box").first();
    expect(row).not.toBeNull();
  });

  test("Accept: application/json triggers the same JSON success", async () => {
    const { id: userId } = await seedUser("moment-accept@example.com");
    const sessionId = await seedSession(userId);
    stubCapPush("accept-box");
    const res = await app.fetch(
      fetchCreate({ __csrf: CSRF, name: "accept-box" }, sessionCookie(sessionId), "accept"),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { redirect?: string };
    expect(body.redirect).toBe(notesDeepLink("accept-box"));
  });

  test("a reserved name → 200 JSON { error } (never the HTML re-render, no vault)", async () => {
    const { id: userId } = await seedUser("moment-reserved@example.com");
    const sessionId = await seedSession(userId);
    const res = await app.fetch(fetchCreate({ __csrf: CSRF, name: "admin" }, sessionCookie(sessionId)), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { error?: string; redirect?: string };
    expect(body.redirect).toBeUndefined();
    expect(body.error).toContain("reserved");
  });

  test("a taken name → 200 JSON { error: already taken }", async () => {
    const { id: a } = await seedUser("moment-owner@example.com");
    const sessionA = await seedSession(a);
    stubCapPush("dup-box");
    const first = await app.fetch(fetchCreate({ __csrf: CSRF, name: "dup-box" }, sessionCookie(sessionA)), env);
    expect(first.status).toBe(200);
    // A second account claims the same name → JSON error, refused before any cap
    // push (so no interceptor is needed for the second attempt).
    const { id: b } = await seedUser("moment-other@example.com");
    const sessionB = await seedSession(b);
    const dup = await app.fetch(fetchCreate({ __csrf: CSRF, name: "dup-box" }, sessionCookie(sessionB)), env);
    expect(dup.status).toBe(200);
    const body = (await dup.json()) as { error?: string };
    expect(body.error).toContain("already taken");
  });

  test("a bad CSRF token under the fetch variant → 200 JSON { error }", async () => {
    const { id: userId } = await seedUser("moment-csrf@example.com");
    const sessionId = await seedSession(userId);
    const res = await app.fetch(fetchCreate({ __csrf: "wrong", name: "csrf-box" }, sessionCookie(sessionId)), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { error?: string; redirect?: string };
    expect(body.redirect).toBeUndefined();
    expect(body.error).toContain("session");
  });

  test("an UNAUTHENTICATED fetch-variant create → 302 /login, no JSON, nothing created", async () => {
    // The `!user` gate runs BEFORE prefersJson, so the fetch signal never earns a
    // JSON body from an anonymous caller — a would-be leak (creating unowned, or
    // an error oracle) is refused with the same neutral login redirect the no-JS
    // path gets. Code order guarantees it today; this pins that order.
    const res = await app.fetch(fetchCreate({ __csrf: CSRF, name: "ghost-box" }, ""), env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
    // A bare redirect carries no content-type at all — certainly not JSON.
    expect(res.headers.get("content-type") ?? "").not.toContain("application/json");
    expect(await res.text()).toBe("");
    const row = await env.DB.prepare("SELECT name FROM vaults WHERE name = ?").bind("ghost-box").first();
    expect(row).toBeNull();
  });

  test("the classic (no header) form POST stays byte-identical: a 303, not JSON", async () => {
    const { id: userId } = await seedUser("moment-classic@example.com");
    const sessionId = await seedSession(userId);
    stubCapPush("classic-box");
    const res = await app.fetch(post("/console/vaults", { __csrf: CSRF, name: "classic-box" }, sessionCookie(sessionId)), env);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(notesDeepLink("classic-box"));
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
      `${APP_ORIGIN}/?add=${encodeURIComponent("https://u.parachute.computer/vault/doorvault")}`,
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
    expect(write.headers.get("location")).toBe(`${APP_ORIGIN}/?add=${base}&redirect=%2Fnew`);

    const imp = await app.fetch(
      post("/console/checklist", { __csrf: CSRF, item: "import-notes" }, sessionCookie(sessionId)),
      env,
    );
    expect(imp.headers.get("location")).toBe(`${APP_ORIGIN}/?add=${base}&redirect=%2Fimport`);
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
