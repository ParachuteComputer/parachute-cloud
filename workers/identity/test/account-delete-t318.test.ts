/**
 * T-318 deletion fixes, against real miniflare D1 and the real router:
 *
 *   1. The undo link: GET renders a page and changes NOTHING (mail scanners
 *      prefetch); the page's form POST restores (CSRF + same-origin); JSON
 *      callers keep the API; an expired link gets a clear page.
 *   2. The request locks every owned vault (`closed: true`) and undo re-opens
 *      it in the same PUT as the entitlement — the lever that stops stateless
 *      vault tokens at request time (the DO half is workers/vault/test/
 *      account-closed.test.ts).
 *   3. The purge removes what used to be left: sign-up magic links stored by
 *      EMAIL with `user_id NULL`, the account's ops_alerts rows — and records
 *      the Stripe outcome on an audit row that survives the user row.
 *   4. The hourly retention purge of spent sign-in artifacts.
 *   5. The operator action for an emailed request: confirm by email, same
 *      request path, audit row naming the operator.
 *   6. The staging hooks: the purge report finds rows in a table added AFTER
 *      the report was written (runtime enumeration), reads zero after a real
 *      sweep, and both hooks 404 in production.
 */
import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import app from "../src/index.ts";
import { ACCOUNT_TOKEN_AUDIENCE } from "../src/account-auth.ts";
import { auditRowsFor, auditTargetHash } from "../src/account-audit.ts";
import { buildPurgeReport } from "../src/account-delete-hooks.ts";
import {
  DELETE_UNDO_WINDOW_MS,
  handleAccountDelete,
  handleAccountDeleteUndo,
  runAccountDeleteSweep,
} from "../src/account-delete.ts";
import { ACCOUNT_TOKEN_CLIENT_ID } from "../src/account-token.ts";
import { createMagicLink, purgeStaleAuthArtifacts } from "../src/magic-links.ts";
import type { EmailSender } from "../src/email.ts";
import type { OAuthDeps } from "../src/oauth-shared.ts";
import { signAccessToken } from "../src/tokens.ts";
import { getUserById } from "../src/users.ts";
import { CSRF, ISSUER, db, deps, seedSession, seedUser, seedVault } from "./helpers.ts";

type VaultFetch = NonNullable<OAuthDeps["vaultFetch"]>;

interface VaultCall {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

/** Records every call the identity worker makes to the vault worker. */
function recordingVault(): { vaultFetch: VaultFetch; calls: VaultCall[] } {
  const calls: VaultCall[] = [];
  const vaultFetch: VaultFetch = async (input, init) => {
    const req = new Request(input, init);
    const body = (await req.clone().json().catch(() => null)) as Record<string, unknown> | null;
    // Host + path: the vault may be addressed by subdomain or by path.
    calls.push({ method: req.method, path: `${new URL(req.url).host}${new URL(req.url).pathname}`, body });
    if (new URL(req.url).pathname.endsWith("/api/internal/destroy")) {
      return Response.json({ destroyed: true, r2_objects_deleted: 3 });
    }
    return Response.json({ ok: true });
  };
  return { vaultFetch, calls };
}

const clock = (d: Date) => () => d;

/** A sender that accepts every send — what staging's devlog sender does. */
const okSender: EmailSender = {
  kind: "devlog",
  sendMagicLink: async () => ({ ok: true }),
  sendOps: async () => ({ ok: true }),
  sendDrip: async () => ({ ok: true }),
} as unknown as EmailSender;

async function bearer(userId: string): Promise<string> {
  return (
    await signAccessToken(db(), {
      sub: userId,
      scopes: [`account:${userId}:admin`],
      audience: ACCOUNT_TOKEN_AUDIENCE,
      clientId: ACCOUNT_TOKEN_CLIENT_ID,
      issuer: ISSUER,
      vaultScope: [],
      ttlSeconds: 600,
    })
  ).token;
}

async function requestDelete(
  userId: string,
  email: string,
  d: OAuthDeps,
): Promise<{ undo_token: string; undo_url: string; deleted_at: string }> {
  const res = await handleAccountDelete(
    env,
    new Request(`${ISSUER}/account/delete`, {
      method: "POST",
      headers: { authorization: `Bearer ${await bearer(userId)}`, "content-type": "application/json" },
      body: JSON.stringify({ confirm: email }),
    }),
    d,
    okSender,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as never;
}

async function tombstone(userId: string): Promise<string | null> {
  return (await getUserById(db(), userId))?.deletedAt ?? null;
}

function cookieOf(res: Response, name: string): string | null {
  const m = new RegExp(`(?:^|[;,]\\s*)${name}=([^;]+)`).exec(res.headers.get("set-cookie") ?? "");
  return m ? m[1]! : null;
}

// --- 1. the undo link --------------------------------------------------------

describe("undo link — GET shows, POST restores", () => {
  test("GET renders the restore page and changes NOTHING; the page's form POST restores", async () => {
    const email = "undo-page@example.com";
    const { id } = await seedUser(email);
    await seedVault("undo-page-notes", id);
    const t0 = new Date();
    const { vaultFetch, calls } = recordingVault();
    const d = { ...deps(clock(t0)), vaultFetch };
    const { undo_token, undo_url } = await requestDelete(id, email, d);
    const deletedAt = await tombstone(id);
    expect(deletedAt).not.toBeNull();

    // A mail scanner (or a person) opens the link: a page, not a restore.
    const page = await handleAccountDeleteUndo(env, new Request(undo_url, { headers: { accept: "text/html" } }), d);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    const html = await page.text();
    expect(html).toContain("Restore your account");
    expect(html).toContain(email);
    expect(html).toContain("undo-page-notes");
    expect(html).toContain('action="/account/undo-delete"');
    expect(html).toContain("Restore my account");
    // Opened twice (prefetch, then the person) — still nothing changed.
    await handleAccountDeleteUndo(env, new Request(undo_url), d);
    expect(await tombstone(id)).toBe(deletedAt);
    // The JSON preview is read-only too.
    const preview = await handleAccountDeleteUndo(env, new Request(undo_url, { headers: { accept: "application/json" } }), d);
    expect(await preview.json()).toMatchObject({ restorable: true });
    expect(await tombstone(id)).toBe(deletedAt);

    // The form POST without the page's CSRF cookie (a cross-site forgery) is refused.
    const csrf = cookieOf(page, "parachute_id_csrf") ?? CSRF;
    const forged = await handleAccountDeleteUndo(
      env,
      new Request(`${ISSUER}/account/undo-delete`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" },
        body: new URLSearchParams({ __csrf: csrf, token: undo_token }),
      }),
      d,
    );
    expect(forged.status).toBe(403);
    expect(await tombstone(id)).toBe(deletedAt);

    // The real button press.
    calls.length = 0;
    const done = await handleAccountDeleteUndo(
      env,
      new Request(`${ISSUER}/account/undo-delete`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: ISSUER,
          cookie: `parachute_id_csrf=${csrf}`,
        },
        body: new URLSearchParams({ __csrf: csrf, token: undo_token }),
      }),
      d,
    );
    expect(done.status).toBe(200);
    const doneHtml = await done.text();
    expect(doneHtml).toContain("Your account is back");
    expect(doneHtml).toContain("Sign in again to continue.");
    expect(await tombstone(id)).toBeNull();
    // The re-open rides the entitlement PUT (one PUT per vault, carrying closed:false).
    const puts = calls.filter((c) => c.method === "PUT" && c.path.endsWith("/api/internal/config"));
    expect(puts).toHaveLength(1);
    expect(puts[0]!.body).toMatchObject({ closed: false });
    // (Same fixed clock for both rows here, so compare as a set.)
    expect((await auditRowsFor(db(), id)).map((a) => a.action).sort()).toEqual(["delete_requested", "delete_undone"]);

    // The link is spent: opening it again gets the clear "doesn't work" page.
    const again = await handleAccountDeleteUndo(env, new Request(undo_url), d);
    expect(again.status).toBe(400);
    expect(await again.text()).toContain("This restore link doesn&#39;t work");
  });

  test("an expired link gets a clear page, not JSON", async () => {
    const email = "undo-late@example.com";
    const { id } = await seedUser(email);
    const t0 = new Date();
    const { undo_url } = await requestDelete(id, email, { ...deps(clock(t0)), vaultFetch: recordingVault().vaultFetch });
    const late = deps(clock(new Date(t0.getTime() + DELETE_UNDO_WINDOW_MS + 1000)));
    const res = await handleAccountDeleteUndo(env, new Request(undo_url), late);
    expect(res.status).toBe(410);
    expect(await res.text()).toContain("The restore window has closed");
  });
});

// --- 2. the vault lock at request time ----------------------------------------

describe("delete request locks every owned vault", () => {
  test("each owned vault gets PUT /api/internal/config {closed:true} from a first-party mint", async () => {
    const email = "lock@example.com";
    const { id } = await seedUser(email);
    await seedVault("lock-a", id);
    await seedVault("lock-b", id);
    const { vaultFetch, calls } = recordingVault();
    await requestDelete(id, email, { ...deps(), vaultFetch });
    const locks = calls.filter((c) => c.method === "PUT" && c.path.endsWith("/api/internal/config"));
    expect(locks).toHaveLength(2);
    expect(locks.some((c) => c.path.includes("lock-a"))).toBe(true);
    expect(locks.some((c) => c.path.includes("lock-b"))).toBe(true);
    for (const c of locks) expect(c.body).toEqual({ closed: true });
    const audit = await auditRowsFor(db(), id);
    expect(audit[0]).toMatchObject({ actor: "self", action: "delete_requested" });
    expect(audit[0]!.note).toMatchObject({ vaults_locked: 2, vaults_lock_failed: 0 });
  });
});

// --- 3. what the purge used to leave behind -------------------------------------

describe("purge — magic links by email, ops_alerts, and the audit row", () => {
  test("sign-up links (user_id NULL) for the email go; another address's link and alerts survive", async () => {
    const email = "Purge-Me@example.com";
    const t0 = new Date(Date.now() - DELETE_UNDO_WINDOW_MS - 60_000);
    // The sign-up link is minted BEFORE the account exists → user_id NULL.
    await createMagicLink(db(), email, null, t0);
    await createMagicLink(db(), "someone-else@example.com", null, t0);
    const { id } = await seedUser(email.toLowerCase());
    await env.DB.prepare("UPDATE users SET stripe_customer_id = NULL WHERE id = ?").bind(id).run();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO ops_alerts (key, last_alert_at) VALUES (?, ?)").bind(`account-purge:${id}`, t0.toISOString()),
      env.DB.prepare("INSERT INTO ops_alerts (key, last_alert_at) VALUES (?, ?)").bind("vault-health", t0.toISOString()),
    ]);
    const { vaultFetch } = recordingVault();
    await seedVault("purge-me-vault", id);
    await requestDelete(id, email.toLowerCase(), { ...deps(clock(t0)), vaultFetch });

    const summary = await runAccountDeleteSweep(env, { ...deps(), vaultFetch }, new Date());
    expect(summary.purged).toBe(1);

    const links = await env.DB.prepare("SELECT email FROM magic_links WHERE email IN (?, ?) ORDER BY email")
      .bind(email.toLowerCase(), "someone-else@example.com")
      .all<{ email: string }>();
    expect((links.results ?? []).map((r) => r.email)).toEqual(["someone-else@example.com"]);
    const alerts = await env.DB.prepare("SELECT key FROM ops_alerts WHERE key IN (?, ?) ORDER BY key")
      .bind(`account-purge:${id}`, "vault-health")
      .all<{ key: string }>();
    expect((alerts.results ?? []).map((r) => r.key)).toEqual(["vault-health"]);

    // The audit trail outlives the user row, keyed by a hash, never the id/email.
    const audit = await auditRowsFor(db(), id);
    expect(audit.map((a) => a.action)).toEqual(["delete_requested", "purged"]);
    expect(audit[1]!.note).toMatchObject({ stripe_customer_before: false, stripe_customer_deleted: false, vaults_destroyed: 1, r2_objects_deleted: 3 });
    const raw = await env.DB.prepare("SELECT * FROM account_audit WHERE target_hash = ?").bind(await auditTargetHash(id)).all();
    expect(JSON.stringify(raw.results)).not.toContain(id);
    expect(JSON.stringify(raw.results).toLowerCase()).not.toContain("purge-me");

    // And the generic report agrees: nothing left anywhere.
    const report = await buildPurgeReport(db(), { email, userId: id, vaults: ["purge-me-vault"] });
    expect(report.remaining_rows_total, JSON.stringify(report.tables)).toBe(0);
    expect(report.notice.sent).toBe(true);
  });
});

// --- 4. retention purge -----------------------------------------------------------

describe("hourly retention purge of spent sign-in artifacts", () => {
  test("links and pending logins past their life by a week go; recent ones stay", async () => {
    const now = new Date();
    const old = new Date(now.getTime() - 8 * 24 * 3600_000);
    const recent = new Date(now.getTime() - 2 * 24 * 3600_000);
    await createMagicLink(db(), "old-signup@example.com", null, old);
    await createMagicLink(db(), "recent-signup@example.com", null, recent);
    const { id } = await seedUser("retention@example.com");
    await env.DB.prepare(
      "INSERT INTO pending_logins (token_hash, user_id, next, created_at, expires_at) VALUES ('old-pl', ?, '/', ?, ?)",
    )
      .bind(id, old.toISOString(), old.toISOString())
      .run();

    const r = await purgeStaleAuthArtifacts(db(), now);
    expect(r.magicLinks).toBeGreaterThanOrEqual(1);
    expect(r.pendingLogins).toBeGreaterThanOrEqual(1);
    const left = await env.DB.prepare("SELECT email FROM magic_links WHERE email IN (?, ?)")
      .bind("old-signup@example.com", "recent-signup@example.com")
      .all<{ email: string }>();
    expect((left.results ?? []).map((x) => x.email)).toEqual(["recent-signup@example.com"]);
  });
});

// --- 5. the operator path ----------------------------------------------------------

function adminPost(path: string, fields: Record<string, string>, cookie: string): Request {
  return new Request(`${ISSUER}${path}`, {
    method: "POST",
    body: new URLSearchParams(fields),
    headers: { "content-type": "application/x-www-form-urlencoded", cookie, origin: ISSUER },
  });
}

describe("operator delete for an emailed request", () => {
  async function operator(email: string): Promise<{ id: string; cookie: string }> {
    const { id } = await seedUser(email);
    await env.DB.prepare("UPDATE users SET role = 'operator' WHERE id = ?").bind(id).run();
    return { id, cookie: `parachute_id_csrf=${CSRF}; parachute_id_session=${await seedSession(id)}` };
  }

  test("confirm by email, then the same request path: tombstone, notice sent, audit names the operator", async () => {
    const op = await operator("op-delete@example.com");
    const { id } = await seedUser("emailed-us@example.com");

    const confirm = await app.fetch(new Request(`${ISSUER}/admin/users/delete?user_id=${id}`, { headers: { cookie: op.cookie } }), env);
    expect(confirm.status).toBe(200);
    expect(await confirm.text()).toContain("Type the account email to confirm");

    const wrong = await app.fetch(adminPost("/admin/users/delete", { __csrf: CSRF, user_id: id, confirm_email: "nope@example.com" }, op.cookie), env);
    expect(wrong.status).toBe(400);
    expect(await tombstone(id)).toBeNull();

    const ok = await app.fetch(adminPost("/admin/users/delete", { __csrf: CSRF, user_id: id, confirm_email: "Emailed-Us@example.com" }, op.cookie), env);
    expect(ok.status).toBe(302);
    expect(ok.headers.get("location")).toBe("/admin/users?notice=delete-requested");
    const after = await getUserById(db(), id);
    expect(after?.deletedAt).not.toBeNull();
    expect(after?.deleteNoticeSentAt).not.toBeNull(); // the holder got the same notice + undo link
    const audit = await auditRowsFor(db(), id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor: `operator:${op.id}`, action: "delete_requested" });

    // The users table now flags it and offers no second delete.
    const list = await (await app.fetch(new Request(`${ISSUER}/admin/users`, { headers: { cookie: op.cookie } }), env)).text();
    expect(list).toContain("deletion requested");
  });

  test("404 for a non-operator (GET and POST), and an operator cannot delete themselves here", async () => {
    const { id } = await seedUser("plain-del@example.com");
    const plain = `parachute_id_csrf=${CSRF}; parachute_id_session=${await seedSession(id)}`;
    expect((await app.fetch(new Request(`${ISSUER}/admin/users/delete?user_id=${id}`, { headers: { cookie: plain } }), env)).status).toBe(404);
    expect((await app.fetch(adminPost("/admin/users/delete", { __csrf: CSRF, user_id: id, confirm_email: "plain-del@example.com" }, plain), env)).status).toBe(404);
    expect(await tombstone(id)).toBeNull();

    const op = await operator("op-self@example.com");
    const self = await app.fetch(adminPost("/admin/users/delete", { __csrf: CSRF, user_id: op.id, confirm_email: "op-self@example.com" }, op.cookie), env);
    expect(self.headers.get("location")).toBe("/admin/users?err=self-delete");
    expect(await tombstone(op.id)).toBeNull();
  });
});

// --- 6. the staging hooks -------------------------------------------------------------

describe("staging hooks — purge report + scoped sweep", () => {
  test("the report enumerates tables at runtime: a table added later is covered without code changes", async () => {
    const email = "report-probe@example.com";
    const { id } = await seedUser(email);
    await env.DB.exec("CREATE TABLE IF NOT EXISTS t318_new_feature (who TEXT, note TEXT)");
    try {
      await env.DB.prepare("INSERT INTO t318_new_feature (who, note) VALUES (?, ?)").bind(`user:${id}`, "x").run();
      const report = await buildPurgeReport(db(), { email });
      expect(report.checked_tables).toContain("t318_new_feature");
      expect(report.tables.t318_new_feature).toEqual({ rows: 1, columns: { who: 1 } });
      expect(report.tables.users!.rows).toBe(1);
      expect(report.remaining_rows_total).toBeGreaterThanOrEqual(2);
    } finally {
      await env.DB.exec("DROP TABLE IF EXISTS t318_new_feature");
    }
  });

  test("POST /__test/account-delete/sweep purges ONLY the named, already-requested account", async () => {
    const t0 = new Date();
    const { id: a } = await seedUser("hook-a@example.com");
    const { id: b } = await seedUser("hook-b@example.com");
    for (const [uid, em] of [
      [a, "hook-a@example.com"],
      [b, "hook-b@example.com"],
    ] as const) {
      await requestDelete(uid, em, { ...deps(clock(t0)), vaultFetch: recordingVault().vaultFetch });
    }
    const res = await app.fetch(
      new Request(`${ISSUER}/__test/account-delete/sweep`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "hook-a@example.com" }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ user_id: a, purged: 1 });
    expect(await getUserById(db(), a)).toBeNull();
    expect(await tombstone(b)).not.toBeNull(); // the other account's 24 hours still run

    const report = await app.fetch(
      new Request(`${ISSUER}/__test/account-delete/report`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "hook-a@example.com", user_id: a }),
      }),
      env,
    );
    const body = (await report.json()) as { remaining_rows_total: number; user: { exists: boolean } };
    expect(body.user.exists).toBe(false);
    expect(body.remaining_rows_total).toBe(0);

    // Only @example.com accounts: a real address is never fast-forwarded.
    const real = await app.fetch(
      new Request(`${ISSUER}/__test/account-delete/sweep`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "person@gmail.com" }),
      }),
      env,
    );
    expect(real.status).toBe(400);
  });

  test("both hooks 404 in production", async () => {
    const prod = { ...env, ENVIRONMENT: "production" };
    for (const path of ["/__test/account-delete/sweep", "/__test/account-delete/report"]) {
      const res = await app.fetch(
        new Request(`${ISSUER}${path}`, { method: "POST", body: JSON.stringify({ email: "x@example.com" }) }),
        prod,
      );
      expect(res.status, path).toBe(404);
    }
  });

  test("the descriptor advertises account_delete", async () => {
    const res = await app.fetch(new Request(`${ISSUER}/.well-known/parachute-account`), env);
    expect(((await res.json()) as { capabilities: Record<string, boolean> }).capabilities).toMatchObject({
      account_delete: true,
      vault_delete: true,
    });
  });
});
