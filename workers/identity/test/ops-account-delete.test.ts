/**
 * POST /ops/account-delete (T-328): the operator agent acting on a person's
 * own WRITTEN deletion request, against real miniflare D1 and the real sweep.
 *
 *   - bearer OPS_DELETE_TOKEN only; unset → the router's 404;
 *   - the address typed twice and a written-request reference, or nothing moves;
 *   - dry_run reads only;
 *   - otherwise the SAME request + purge as self-service, with the 24-hour
 *     undo window waived and NO email to anyone (the operator replies by hand);
 *   - rows keyed by the EMAIL go even when no account row exists (a sign-up
 *     that was never finished);
 *   - a vault that will not destroy defers: the account row stays.
 */
import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import app from "../src/index.ts";
import { auditRowsFor } from "../src/account-audit.ts";
import { handleAccountDelete } from "../src/account-delete.ts";
import { ACCOUNT_TOKEN_AUDIENCE } from "../src/account-auth.ts";
import { ACCOUNT_TOKEN_CLIENT_ID } from "../src/account-token.ts";
import { createMagicLink } from "../src/magic-links.ts";
import type { EmailSender } from "../src/email.ts";
import type { OAuthDeps } from "../src/oauth-shared.ts";
import { handleOpsAccountDeletePost } from "../src/ops-account-delete.ts";
import { signAccessToken } from "../src/tokens.ts";
import { getUserById } from "../src/users.ts";
import { ISSUER, db, deps, seedSession, seedUser, seedVault } from "./helpers.ts";

type VaultFetch = NonNullable<OAuthDeps["vaultFetch"]>;
const TOKEN = "ops-delete-test-token";
const REF = "T-328 emailed request 2026-10-28";

/** Records every vault call; `failDestroy` names vaults whose destroy answers 500. */
function recordingVault(failDestroy: string[] = []): { vaultFetch: VaultFetch; destroyed: string[] } {
  const destroyed: string[] = [];
  const vaultFetch: VaultFetch = async (input, init) => {
    const url = new URL(new Request(input, init).url);
    if (url.pathname.endsWith("/api/internal/destroy")) {
      const name = url.pathname.split("/").find((s, i, a) => a[i - 1] === "vault") ?? url.host.split(".")[0]!;
      if (failDestroy.includes(name)) return Response.json({ error: "boom" }, { status: 500 });
      destroyed.push(name);
      return Response.json({ destroyed: true, r2_objects_deleted: 2 });
    }
    return Response.json({ ok: true });
  };
  return { vaultFetch, destroyed };
}

function call(
  body: unknown,
  opts: { auth?: string; secret?: string | null; vaultFetch?: VaultFetch; now?: Date; sender?: EmailSender } = {},
): Promise<Response | null> {
  const e = opts.secret === null ? { ...env } : { ...env, OPS_DELETE_TOKEN: opts.secret ?? TOKEN };
  const headers: Record<string, string> = { "content-type": "application/json" };
  const auth = opts.auth === undefined ? `Bearer ${TOKEN}` : opts.auth;
  if (auth) headers.authorization = auth;
  const now = opts.now;
  return handleOpsAccountDeletePost(
    e,
    new Request(`${ISSUER}/ops/account-delete`, { method: "POST", headers, body: JSON.stringify(body) }),
    { ...deps(now ? () => now : undefined), vaultFetch: opts.vaultFetch ?? recordingVault().vaultFetch },
    opts.sender,
  );
}

/** Records every send; the ops door must never mail the account holder. */
function spySender(): { sender: EmailSender; to: string[] } {
  const to: string[] = [];
  const rec = async (m: { to: string }) => (to.push(m.to), { ok: true });
  return {
    sender: { kind: "devlog", sendOps: rec, sendMagicLink: rec, sendDrip: rec } as unknown as EmailSender,
    to,
  };
}

async function json(res: Response | null): Promise<Record<string, any>> {
  expect(res).not.toBeNull();
  return (await res!.json()) as Record<string, any>;
}

async function count(sql: string, ...binds: unknown[]): Promise<number> {
  return (await env.DB.prepare(sql).bind(...binds).first<{ n: number }>())!.n;
}

describe("POST /ops/account-delete — the gate", () => {
  test("unset secret → null (404 at the router); wrong or other ops bearers → 401; nothing moves", async () => {
    const { id } = await seedUser("gate@example.com");
    const body = { email: "gate@example.com", confirm: "gate@example.com", written_request: REF };
    expect(await call(body, { secret: null })).toBeNull();
    const routed = (e: typeof env) =>
      app.fetch(
        new Request(`${ISSUER}/ops/account-delete`, {
          method: "POST",
          headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify({ ...body, dry_run: true }),
        }),
        e,
      );
    expect((await routed(env)).status).toBe(404);
    // Wired: with the secret set, the router reaches the handler (a dry run touches nothing).
    const wired = await routed({ ...env, OPS_DELETE_TOKEN: TOKEN });
    expect(wired.status).toBe(200);
    expect(await wired.json()).toMatchObject({ dry_run: true, account_found: true, user_id: id });
    expect((await call(body, { auth: "" }))!.status).toBe(401);
    expect((await call(body, { auth: `Bearer ${TOKEN}x` }))!.status).toBe(401);
    const runOnly = { ...env, OPS_DELETE_TOKEN: TOKEN, OPS_RUN_TOKEN: "run", OPS_READ_TOKEN: "read" };
    for (const other of ["run", "read"]) {
      const r = await handleOpsAccountDeletePost(
        runOnly,
        new Request(`${ISSUER}/ops/account-delete`, {
          method: "POST",
          headers: { authorization: `Bearer ${other}` },
          body: JSON.stringify(body),
        }),
        deps(),
      );
      expect(r!.status).toBe(401);
    }
    expect((await getUserById(db(), id))?.deletedAt).toBeNull();
  });

  test("the address typed twice and a written-request reference, or 400 and nothing moves", async () => {
    const { id } = await seedUser("retype@example.com");
    for (const body of [
      { email: "retype@example.com", confirm: "other@example.com", written_request: REF },
      { email: "retype@example.com", written_request: REF },
      { email: "retype@example.com", confirm: "retype@example.com" },
      { email: "retype@example.com", confirm: "retype@example.com", written_request: "  " },
      // The reference is stored on the audit row, which never holds an address.
      { email: "retype@example.com", confirm: "retype@example.com", written_request: "from retype@example.com" },
      { email: "", confirm: "", written_request: REF },
      { email: "a@b", confirm: "a@b", written_request: REF },
    ]) {
      expect((await call(body))!.status, JSON.stringify(body)).toBe(400);
    }
    expect((await getUserById(db(), id))?.deletedAt).toBeNull();
  });
});

describe("POST /ops/account-delete — dry run", () => {
  test("reports what is there and changes nothing", async () => {
    const email = "dry@example.com";
    const { id } = await seedUser(email);
    await seedVault("dry-one", id);
    await seedVault("dry-two", id);
    await createMagicLink(db(), email, null, new Date());
    const out = await json(await call({ email, confirm: email, written_request: REF, dry_run: true }));
    expect(out).toMatchObject({ dry_run: true, account_found: true, user_id: id, tombstoned_before: false });
    expect(out.vaults.map((v: { name: string }) => v.name).sort()).toEqual(["dry-one", "dry-two"]);
    expect(out.email_rows.magic_links).toBe(1);
    expect((await getUserById(db(), id))?.deletedAt).toBeNull();
    expect(await count("SELECT COUNT(*) AS n FROM vaults WHERE owner_user_id = ?", id)).toBe(2);
    expect(await count("SELECT COUNT(*) AS n FROM magic_links WHERE email = ?", email)).toBe(1);
  });
});

describe("POST /ops/account-delete — the purge", () => {
  test("a live account is erased NOW: vaults destroyed, every row gone, no email sent, others untouched", async () => {
    const email = "erase-now@example.com";
    const { id } = await seedUser(email);
    await seedVault("erase-now-a", id);
    await seedVault("erase-now-b", id);
    await seedSession(id);
    // The sign-up link that made the account, stored before it existed (user_id NULL).
    await createMagicLink(db(), email, null, new Date(Date.now() - 3600_000));
    const { id: other } = await seedUser("bystander@example.com");
    await seedVault("bystander-notes", other);
    await createMagicLink(db(), "bystander@example.com", null, new Date());

    const { vaultFetch, destroyed } = recordingVault();
    const mail = spySender();
    // Typed with different case and spaces, as it may arrive in an email.
    const out = await json(
      await call(
        { email: " Erase-Now@Example.com ", confirm: "erase-now@example.com", written_request: REF },
        { vaultFetch, sender: mail.sender },
      ),
    );
    expect(mail.to).toEqual([]); // the holder is not mailed; the operator replies by hand
    expect(out).toMatchObject({ done: true, account_found: true, user_id: id });
    expect(out.sweep).toMatchObject({ purged: 1, deferred: 0 });
    expect(destroyed.sort()).toEqual(["erase-now-a", "erase-now-b"]);
    expect(out.report.remaining_rows_total).toBe(0);
    expect(out.report.email_rows_total).toBe(0);

    expect(await getUserById(db(), id)).toBeNull();
    expect(await count("SELECT COUNT(*) AS n FROM vaults WHERE owner_user_id = ?", id)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?", id)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM magic_links WHERE email = ?", email)).toBe(0);
    // Nobody else's rows moved.
    expect(await getUserById(db(), other)).not.toBeNull();
    expect(await count("SELECT COUNT(*) AS n FROM vaults WHERE owner_user_id = ?", other)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM magic_links WHERE email = ?", "bystander@example.com")).toBe(1);

    // The record: requested by the operator, purged by the sweep with the window waived.
    const audit = await auditRowsFor(db(), id);
    expect(audit.map((a) => [a.actor, a.action])).toEqual([
      ["operator:ops-agent", "delete_requested"],
      ["sweep", "purged"],
    ]);
    expect(audit[0]!.note).toMatchObject({ notice_sent: false, written_request: REF });
    expect(audit[1]!.note).toMatchObject({ undo_window_waived: true, vaults_destroyed: 2, written_request: REF });
  });

  test("an account already inside its self-service 24-hour window is erased now, not tomorrow", async () => {
    const email = "in-window@example.com";
    const { id } = await seedUser(email);
    await seedVault("in-window-notes", id);
    const sent: string[] = [];
    const sender = {
      kind: "devlog",
      sendOps: async (m: { subject: string }) => (sent.push(m.subject), { ok: true }),
    } as unknown as EmailSender;
    const bearer = (
      await signAccessToken(db(), {
        sub: id,
        scopes: [`account:${id}:admin`],
        audience: ACCOUNT_TOKEN_AUDIENCE,
        clientId: ACCOUNT_TOKEN_CLIENT_ID,
        issuer: ISSUER,
        vaultScope: [],
        ttlSeconds: 600,
      })
    ).token;
    const { vaultFetch, destroyed } = recordingVault();
    const self = await handleAccountDelete(
      env,
      new Request(`${ISSUER}/account/delete`, {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        body: JSON.stringify({ confirm: email }),
      }),
      { ...deps(), vaultFetch },
      sender,
    );
    expect(self.status).toBe(200);
    expect(sent).toHaveLength(1);

    const out = await json(await call({ email, confirm: email, written_request: REF }, { vaultFetch }));
    expect(out).toMatchObject({ done: true, account_found: true, tombstoned_before: true });
    expect(destroyed).toEqual(["in-window-notes"]);
    expect(await getUserById(db(), id)).toBeNull();
    expect(sent).toHaveLength(1); // the operator path sent nothing more
    // The holder's own request opened it; the purge row carries the written request that waived the window.
    const audit = await auditRowsFor(db(), id);
    expect(audit.map((a) => [a.actor, a.action])).toEqual([
      ["self", "delete_requested"],
      ["sweep", "purged"],
    ]);
    expect(audit[1]!.note).toMatchObject({ undo_window_waived: true, written_request: REF });
  });

  test("a look-alike address or vault name elsewhere is not a leftover: done is true, and those rows stay", async () => {
    const email = "ike@example.co";
    const { id } = await seedUser(email);
    await seedVault("notes", id);
    // Someone else: an address that CONTAINS this one, a vault whose name starts with this one's,
    // and a client registration naming that other vault.
    const { id: other } = await seedUser("mike@example.com");
    await seedVault("notes2", other);
    await createMagicLink(db(), "mike@example.com", null, new Date());
    await env.DB.prepare("INSERT INTO ops_alerts (key, last_alert_at) VALUES (?, ?)")
      .bind("snapshot:vault.notes2:stale", new Date().toISOString())
      .run();
    const out = await json(await call({ email, confirm: email, written_request: REF }));
    expect(out, JSON.stringify(out.report)).toMatchObject({ done: true, account_found: true });
    expect(out.report.remaining_rows_total).toBe(0);
    expect(await getUserById(db(), other)).not.toBeNull();
    expect(await count("SELECT COUNT(*) AS n FROM vaults WHERE name = 'notes2'")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM magic_links WHERE email = 'mike@example.com'")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM ops_alerts WHERE key = 'snapshot:vault.notes2:stale'")).toBe(1);
  });

  test("no account row, only a never-finished sign-up: the email-keyed rows still go", async () => {
    const email = "never-finished@example.com";
    await createMagicLink(db(), email, null, new Date(Date.now() - 600_000));
    await createMagicLink(db(), email, null, new Date());
    await createMagicLink(db(), "someone-else@example.com", null, new Date());
    const out = await json(await call({ email, confirm: email, written_request: REF }));
    expect(out).toMatchObject({ done: true, account_found: false, magic_links_deleted: 2 });
    expect(out.report.email_rows_total).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM magic_links WHERE email = ?", email)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM magic_links WHERE email = ?", "someone-else@example.com")).toBe(1);
  });

  test("a vault that will not destroy defers: the account row and that vault stay, done is false", async () => {
    const email = "wedged@example.com";
    const { id } = await seedUser(email);
    await seedVault("wedged-ok", id);
    await seedVault("wedged-stuck", id);
    const { vaultFetch } = recordingVault(["wedged-stuck"]);
    const res = await call({ email, confirm: email, written_request: REF }, { vaultFetch });
    expect(res!.status).toBe(502);
    const out = await json(res);
    expect(out).toMatchObject({ done: false, account_found: true });
    expect(out.sweep).toMatchObject({ purged: 0, deferred: 1 });
    expect(out.purge_attempts).toBe(1);
    const user = await getUserById(db(), id);
    expect(user?.deletedAt).not.toBeNull();
    expect(await count("SELECT COUNT(*) AS n FROM vaults WHERE owner_user_id = ?", id)).toBe(1);

    // A second call converges once the vault answers.
    const again = await json(await call({ email, confirm: email, written_request: REF }));
    expect(again).toMatchObject({ done: true, account_found: true, tombstoned_before: true });
    expect(await getUserById(db(), id)).toBeNull();
  });

  test("an operator account cannot be erased this way", async () => {
    const email = "op@example.com";
    const { id } = await seedUser(email);
    await env.DB.prepare("UPDATE users SET role = 'operator' WHERE id = ?").bind(id).run();
    const res = await call({ email, confirm: email, written_request: REF });
    expect(res!.status).toBe(409);
    expect((await getUserById(db(), id))?.deletedAt).toBeNull();
  });
});
