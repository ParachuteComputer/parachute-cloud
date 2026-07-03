/**
 * The operator admin console (Wave 4c) — role gate, fleet views, the comp +
 * suspend levers, and the suspension semantics (migration 0011's contract).
 *
 * Pins:
 *   - EVERY /admin route (GETs and POSTs) answers 404 — the router's own
 *     unknown-path shape — for no-session AND plain-user sessions; only an
 *     operator session gets in. Not a 403, not a login redirect: the surface
 *     never reveals it exists.
 *   - suspension: sessions die (rows deleted + read-time refusal), password
 *     login answers the exact wrong-password message even on the correct
 *     password, magic request answers the neutral page WITHOUT minting a link
 *     (and without the dev echo header), a pre-suspension link verifies to the
 *     same dead-link 400 — and un-suspending restores login exactly.
 *   - the comp lever pushes caps through the REAL transport (fetchMock over
 *     global fetch): setUserPlan + applyPlanToVaults in one action.
 *   - pagination at 50/page; CSRF + same-origin on the actions; IDOR-safe
 *     (targets must exist; values allowlisted; self-suspend refused).
 */
import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import app from "../src/index.ts";
import { ADMIN_PAGE_SIZE } from "../src/admin.ts";
import { PLAN_SPECS } from "../src/plans.ts";
import { findActiveSession } from "../src/sessions.ts";
import { getUserById } from "../src/users.ts";
import { CSRF, ISSUER, seedSession, seedUser, seedVault } from "./helpers.ts";

// --- request builders (browser-shaped) --------------------------------------

function get(path: string, cookie?: string): Request {
  return new Request(`${ISSUER}${path}`, { headers: cookie ? { cookie } : {} });
}

function post(path: string, fields: Record<string, string>, cookie: string, origin: string | null = ISSUER): Request {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", cookie };
  if (origin) headers.origin = origin;
  return new Request(`${ISSUER}${path}`, { method: "POST", body: new URLSearchParams(fields), headers });
}

function cookieFor(sessionId: string): string {
  return `parachute_id_csrf=${CSRF}; parachute_id_session=${sessionId}`;
}

/** A user + live session, promoted to operator via the script's own write. */
async function seedOperator(email = "operator@example.com"): Promise<{ id: string; cookie: string }> {
  const { id } = await seedUser(email);
  await env.DB.prepare("UPDATE users SET role = 'operator' WHERE id = ?").bind(id).run();
  return { id, cookie: cookieFor(await seedSession(id)) };
}

const ADMIN_GETS = ["/admin", "/admin/users", "/admin/vaults"];
const ADMIN_POSTS = ["/admin/users/plan", "/admin/users/suspend"];

// --- the role gate -----------------------------------------------------------

describe("role gate — 404 for everyone but an operator", () => {
  test("no session: every admin route (GETs + POSTs) is the router's own 404", async () => {
    for (const path of ADMIN_GETS) {
      const res = await app.fetch(get(path), env);
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).toBe("404 Not Found"); // byte-identical to an unknown route
    }
    for (const path of ADMIN_POSTS) {
      const res = await app.fetch(post(path, { __csrf: CSRF, user_id: "x" }, `parachute_id_csrf=${CSRF}`), env);
      expect(res.status, path).toBe(404);
    }
    // The reference shape: an unknown path answers the same way.
    const unknown = await app.fetch(get("/definitely-not-a-route"), env);
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toBe("404 Not Found");
  });

  test("a plain user session: still 404 everywhere, incl. POSTs with valid CSRF", async () => {
    const { id } = await seedUser("plain@example.com");
    const cookie = cookieFor(await seedSession(id));
    for (const path of ADMIN_GETS) {
      expect((await app.fetch(get(path, cookie), env)).status, path).toBe(404);
    }
    for (const path of ADMIN_POSTS) {
      const res = await app.fetch(post(path, { __csrf: CSRF, user_id: id, plan: "parachute", act: "suspend" }, cookie), env);
      expect(res.status, path).toBe(404);
    }
    // And no state changed: the user did not suspend themselves.
    expect((await getUserById(env.DB, id))!.suspendedAt).toBeNull();
  });

  test("an operator session: the three views answer 200", async () => {
    const { cookie } = await seedOperator();
    for (const path of ADMIN_GETS) {
      const res = await app.fetch(get(path, cookie), env);
      expect(res.status, path).toBe(200);
    }
  });

  test("the console header shows the Admin link ONLY to operators", async () => {
    const { id, cookie } = await seedOperator("navop@example.com");
    await seedVault("navop-box", id);
    const opHtml = await (await app.fetch(get("/console", cookie), env)).text();
    expect(opHtml).toContain('data-testid="admin-link"');

    const { id: plainId } = await seedUser("navplain@example.com");
    const plainHtml = await (await app.fetch(get("/console", cookieFor(await seedSession(plainId))), env)).text();
    expect(plainHtml).not.toContain('data-testid="admin-link"');
  });
});

// --- the overview -------------------------------------------------------------

describe("GET /admin — the fleet overview", () => {
  test("totals, 7d counters, signups/day, drip events, ops alerts all render", async () => {
    const { id: opId, cookie } = await seedOperator("overview-op@example.com");
    const { id: u1 } = await seedUser("overview-a@example.com");
    await seedUser("overview-b@example.com");
    await seedVault("overview-box", u1);

    const today = new Date().toISOString().slice(0, 10);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO magic_link_events (day, event, count) VALUES (?, 'sent', 7)").bind(today),
      env.DB.prepare("INSERT INTO magic_link_events (day, event, count) VALUES (?, 'failed', 2)").bind(today),
      env.DB.prepare("INSERT INTO drip_events (day, event, count) VALUES (?, 'welcome:sent', 3)").bind(today),
      env.DB.prepare("INSERT INTO drip_events (day, event, count) VALUES (?, 'unsubscribed', 1)").bind(today),
      env.DB.prepare("INSERT INTO ops_alerts (key, last_alert_at) VALUES ('health:vault-health', ?)").bind(
        new Date().toISOString(),
      ),
    ]);

    const res = await app.fetch(get("/admin", cookie), env);
    expect(res.status).toBe(200);
    const html = await res.text();
    // Totals: exactly the 3 users this test created (isolated storage).
    expect(html).toContain("Users");
    expect(html).toContain("+3 in 7d");
    expect(html).toContain("+1 in 7d"); // vaults
    // Magic counters (the digest queries, surfaced).
    expect(html).toContain("2 failed");
    // Signups/day: 7 zero-filled rows, today's counting this test's 3 signups.
    expect(html.match(/data-testid="admin-signup-day"/g)?.length).toBe(7);
    expect(html).toContain(`<td>${today}</td><td style="width:4rem;text-align:right">3</td>`);
    // Drip events by kind + the ops alert row.
    expect(html).toContain("welcome:sent");
    expect(html).toContain("unsubscribed");
    expect(html).toContain("health:vault-health");
    void opId;
  });
});

// --- the users table -----------------------------------------------------------

describe("GET /admin/users — the accounts table", () => {
  test("a row carries email, plan, created, vault count, checklist progress, drip-unsub flag", async () => {
    const { cookie } = await seedOperator("table-op@example.com");
    const { id } = await seedUser("table-user@example.com");
    await seedVault("table-box-1", id);
    await seedVault("table-box-2", id);
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO user_checklist (user_id, item, done_at) VALUES (?, 'open-notes', ?)").bind(id, now),
      env.DB.prepare("INSERT INTO user_checklist (user_id, item, done_at) VALUES (?, 'write-note', ?)").bind(id, now),
      // The reserved dismissal row must NOT count as progress.
      env.DB.prepare("INSERT INTO user_checklist (user_id, item, done_at) VALUES (?, 'hidden', ?)").bind(id, now),
      env.DB.prepare("UPDATE users SET drip_unsubscribed = ? WHERE id = ?").bind(now, id),
    ]);

    const html = await (await app.fetch(get("/admin/users", cookie), env)).text();
    expect(html).toContain("table-user@example.com");
    expect(html).toContain(">Free<");
    expect(html).toContain(">2</td>"); // vault count
    expect(html).toContain(">2/5</td>"); // checklist progress, hidden excluded
    expect(html).toContain("drip-unsub");
    expect(html).toContain(now.slice(0, 10));
  });

  test("pagination: 50 per page, newest first, page clamped into range", async () => {
    const { cookie } = await seedOperator("page-op@example.com");
    // 54 more accounts → 55 total → 2 pages (50 + 5).
    const now = Date.now();
    const stmts = [];
    for (let i = 0; i < 54; i++) {
      stmts.push(
        env.DB.prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, '', ?)").bind(
          `page-user-${i}`,
          `page-${i}@example.com`,
          new Date(now - i * 1000).toISOString(),
        ),
      );
    }
    await env.DB.batch(stmts);

    const p1 = await (await app.fetch(get("/admin/users", cookie), env)).text();
    expect(p1.match(/data-testid="admin-user-row"/g)?.length).toBe(ADMIN_PAGE_SIZE);
    expect(p1).toContain("Page 1 of 2");

    const p2 = await (await app.fetch(get("/admin/users?page=2", cookie), env)).text();
    expect(p2.match(/data-testid="admin-user-row"/g)?.length).toBe(5);
    expect(p2).toContain("Page 2 of 2");

    // Out-of-range + garbage pages clamp instead of erroring or leaking.
    const clamped = await (await app.fetch(get("/admin/users?page=999", cookie), env)).text();
    expect(clamped).toContain("Page 2 of 2");
    const garbage = await app.fetch(get("/admin/users?page=banana", cookie), env);
    expect(garbage.status).toBe(200);
    expect(await garbage.text()).toContain("Page 1 of 2");
  });
});

// --- the vaults table -----------------------------------------------------------

describe("GET /admin/vaults — the fleet table", () => {
  test("rows carry owner email, latest rollup usage, and the owner's plan cap", async () => {
    const { cookie } = await seedOperator("vt-op@example.com");
    const { id } = await seedUser("vt-owner@example.com");
    await env.DB.prepare("UPDATE users SET plan = 'parachute' WHERE id = ?").bind(id).run();
    await seedVault("vt-box", id);
    const today = new Date().toISOString().slice(0, 10);
    await env.DB.prepare("INSERT INTO vault_usage (vault_name, day, db_bytes, r2_bytes) VALUES ('vt-box', ?, 2097152, 1048576)")
      .bind(today)
      .run();

    const html = await (await app.fetch(get("/admin/vaults", cookie), env)).text();
    expect(html).toContain("vt-box");
    expect(html).toContain("vt-owner@example.com");
    expect(html).toContain("3.0 MB"); // db 2 MiB + r2 1 MiB
    expect(html).toContain("10 GiB"); // the parachute cap
  });

  test("a vault with no rollup row yet says so instead of inventing a zero", async () => {
    const { cookie } = await seedOperator("vt2-op@example.com");
    const { id } = await seedUser("vt2-owner@example.com");
    await seedVault("vt2-box", id);
    const html = await (await app.fetch(get("/admin/vaults", cookie), env)).text();
    expect(html).toContain("no rollup row yet");
    expect(html).toContain("100 MB"); // the free cap
  });
});

// --- the comp lever (set plan → cap push) --------------------------------------

describe("POST /admin/users/plan — the comp lever", () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });
  afterEach(() => fetchMock.assertNoPendingInterceptors());

  test("sets the plan AND pushes the new cap into every owned vault (applyPlanToVaults)", async () => {
    const { cookie } = await seedOperator("comp-op@example.com");
    const { id } = await seedUser("comp-user@example.com");
    await seedVault("comp-box", id);

    let body: string | undefined;
    fetchMock
      .get(env.VAULT_ORIGIN!)
      .intercept({
        path: "/vault/comp-box/api/internal/config",
        method: "PUT",
        body: (raw: string) => {
          body = raw;
          return true;
        },
      })
      .reply(200, { resolved_cap_bytes: PLAN_SPECS.parachute.total_bytes }, { headers: { "content-type": "application/json" } });

    const res = await app.fetch(post("/admin/users/plan", { __csrf: CSRF, user_id: id, plan: "parachute" }, cookie), env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin/users?notice=plan-updated");
    expect((await getUserById(env.DB, id))!.plan).toBe("parachute");
    // The pushed cap is the NEW plan's total — the comp takes effect now.
    expect(JSON.parse(body!)).toEqual({ cap_bytes: PLAN_SPECS.parachute.total_bytes });
  });

  test("a failed cap push still comps the plan and reports partially", async () => {
    const { cookie } = await seedOperator("comp2-op@example.com");
    const { id } = await seedUser("comp2-user@example.com");
    await seedVault("comp2-box", id);
    fetchMock
      .get(env.VAULT_ORIGIN!)
      .intercept({ path: "/vault/comp2-box/api/internal/config", method: "PUT" })
      .reply(500, "nope");
    const res = await app.fetch(post("/admin/users/plan", { __csrf: CSRF, user_id: id, plan: "parachute" }, cookie), env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin/users?notice=plan-partial");
    expect((await getUserById(env.DB, id))!.plan).toBe("parachute");
  });

  test("IDOR-safe: unknown target or unknown plan changes nothing", async () => {
    const { cookie } = await seedOperator("idor-op@example.com");
    const missing = await app.fetch(
      post("/admin/users/plan", { __csrf: CSRF, user_id: "no-such-user", plan: "parachute" }, cookie),
      env,
    );
    expect(missing.status).toBe(302);
    expect(missing.headers.get("location")).toBe("/admin/users?err=not-found");

    const { id } = await seedUser("idor-user@example.com");
    const badPlan = await app.fetch(
      post("/admin/users/plan", { __csrf: CSRF, user_id: id, plan: "enterprise-mega" }, cookie),
      env,
    );
    expect(badPlan.status).toBe(302);
    expect(badPlan.headers.get("location")).toBe("/admin/users?err=invalid");
    expect((await getUserById(env.DB, id))!.plan).toBe("free");
  });

  test("CSRF + same-origin gate the action (no state change without both)", async () => {
    const { cookie } = await seedOperator("csrf-op@example.com");
    const { id } = await seedUser("csrf-user@example.com");
    // Missing CSRF field.
    const noCsrf = await app.fetch(post("/admin/users/plan", { user_id: id, plan: "parachute" }, cookie), env);
    expect(noCsrf.status).toBe(302);
    expect(noCsrf.headers.get("location")).toBe("/admin/users?err=csrf");
    // Foreign origin.
    const foreign = await app.fetch(
      post("/admin/users/plan", { __csrf: CSRF, user_id: id, plan: "parachute" }, cookie, "https://evil.example"),
      env,
    );
    expect(foreign.status).toBe(302);
    expect(foreign.headers.get("location")).toBe("/admin/users?err=csrf");
    expect((await getUserById(env.DB, id))!.plan).toBe("free");
  });
});

// --- suspension ---------------------------------------------------------------

describe("POST /admin/users/suspend + the suspension semantics", () => {
  const PASSWORD = "correct horse";

  async function suspend(operatorCookie: string, targetId: string): Promise<Response> {
    return app.fetch(post("/admin/users/suspend", { __csrf: CSRF, user_id: targetId, act: "suspend" }, operatorCookie), env);
  }

  test("suspend invalidates live sessions NOW (rows deleted + read-time refusal)", async () => {
    const { cookie: opCookie } = await seedOperator("sus-op@example.com");
    const { id } = await seedUser("sus-user@example.com", PASSWORD);
    const targetSession = await seedSession(id);

    // Pre-suspension: the session works.
    expect((await app.fetch(get("/console", cookieFor(targetSession)), env)).status).toBe(200);

    const res = await suspend(opCookie, id);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin/users?notice=suspended");
    expect((await getUserById(env.DB, id))!.suspendedAt).not.toBeNull();

    // Session rows are gone…
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?").bind(id).first<{ n: number }>();
    expect(rows!.n).toBe(0);
    // …and the old cookie acts logged-out on the next request.
    const after = await app.fetch(get("/console", cookieFor(targetSession)), env);
    expect(after.status).toBe(302);
    expect(after.headers.get("location")).toBe("/login");
    // The read-time backstop itself (covers a session raced past the delete).
    const raced = await seedSession(id);
    expect(await findActiveSession(env.DB, raced)).toBeNull();
  });

  test("suspended password login: the exact wrong-password message, even on the correct password; un-suspend restores", async () => {
    const { cookie: opCookie } = await seedOperator("sus2-op@example.com");
    const { id } = await seedUser("sus2-user@example.com", PASSWORD);
    await suspend(opCookie, id);

    const login = await app.fetch(
      post("/login", { __csrf: CSRF, email: "sus2-user@example.com", password: PASSWORD }, `parachute_id_csrf=${CSRF}`),
      env,
    );
    expect(login.status).toBe(200); // the error re-render, not a redirect
    expect(await login.text()).toContain("Incorrect email or password.");
    expect(login.headers.get("set-cookie") ?? "").not.toContain("parachute_id_session=");

    // Un-suspend: sign-in works again, nothing else was touched.
    const un = await app.fetch(post("/admin/users/suspend", { __csrf: CSRF, user_id: id, act: "unsuspend" }, opCookie), env);
    expect(un.headers.get("location")).toBe("/admin/users?notice=unsuspended");
    expect((await getUserById(env.DB, id))!.suspendedAt).toBeNull();
    const login2 = await app.fetch(
      post("/login", { __csrf: CSRF, email: "sus2-user@example.com", password: PASSWORD }, `parachute_id_csrf=${CSRF}`),
      env,
    );
    expect(login2.status).toBe(302);
    expect(login2.headers.get("location")).toBe("/console");
  });

  test("suspended magic request: the same neutral page, but NOTHING minted (no row, no echo header)", async () => {
    const { cookie: opCookie } = await seedOperator("sus3-op@example.com");
    const { id } = await seedUser("sus3-user@example.com", PASSWORD);

    // Control: a live account's request mints a link + carries the dev echo
    // header (ENVIRONMENT="test" → exposeDevLinks).
    const before = await app.fetch(
      post("/auth/magic", { __csrf: CSRF, email: "sus3-user@example.com" }, `parachute_id_csrf=${CSRF}`),
      env,
    );
    expect(before.status).toBe(200);
    const liveLink = before.headers.get("x-parachute-dev-magic-link");
    expect(liveLink).not.toBeNull();

    await suspend(opCookie, id);

    const after = await app.fetch(
      post("/auth/magic", { __csrf: CSRF, email: "sus3-user@example.com" }, `parachute_id_csrf=${CSRF}`),
      env,
    );
    expect(after.status).toBe(200); // the identical neutral "check your email" page
    expect(await after.text()).toContain("Check your email");
    expect(after.headers.get("x-parachute-dev-magic-link")).toBeNull();
    // Exactly the ONE pre-suspension link row exists — nothing new was minted.
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM magic_links WHERE email = 'sus3-user@example.com'").first<{ n: number }>();
    expect(rows!.n).toBe(1);

    // The pre-suspension link is dead too: the same 400 an expired link gets.
    const verify = await app.fetch(new Request(liveLink!), env);
    expect(verify.status).toBe(400);
    expect(await verify.text()).toContain("Link expired");
  });

  test("IDOR-safe + self-suspend refused + invalid act refused", async () => {
    const { id: opId, cookie: opCookie } = await seedOperator("sus4-op@example.com");
    const missing = await suspend(opCookie, "no-such-user");
    expect(missing.headers.get("location")).toBe("/admin/users?err=not-found");

    const self = await suspend(opCookie, opId);
    expect(self.headers.get("location")).toBe("/admin/users?err=self-suspend");
    expect((await getUserById(env.DB, opId))!.suspendedAt).toBeNull();

    const { id } = await seedUser("sus4-user@example.com");
    const bad = await app.fetch(post("/admin/users/suspend", { __csrf: CSRF, user_id: id, act: "obliterate" }, opCookie), env);
    expect(bad.headers.get("location")).toBe("/admin/users?err=invalid");
    expect((await getUserById(env.DB, id))!.suspendedAt).toBeNull();
  });
});
