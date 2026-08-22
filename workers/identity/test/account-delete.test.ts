/**
 * Account deletion end-to-end (cloud#226 A-3 + A-4, account-delete.ts) — the
 * lifecycle Aaron ratified, one describe per leg:
 *
 *   1. REQUEST — auth severed immediately, billing held reversibly, the
 *      tombstone + undo hash written, and NOTHING erased.
 *   2. THE WINDOW — for 24 hours the data is intact but unreachable, and the
 *      sweep will not touch it.
 *   3. UNDO — inside the window the account comes back, billing is released,
 *      the token is single-use, and every unusable token gets one neutral
 *      answer.
 *   4. CONVERGENCE — past the window the sweep really removes the billing
 *      artifacts AND the vault storage AND the account rows, and afterwards
 *      every read refuses.
 *
 * WHAT IS NOT RE-PROVEN HERE. The Stripe mechanics of deferBilling /
 * resumeBilling / teardownBilling (tolerable-vs-hard errors, the cloud#64
 * orphan belt, the NULL-ids converged marker) are billing-teardown.test.ts's
 * subject and are pinned there against the same injected-stub seam; this suite
 * asserts only that the ROUTES call them at the right moment and honor their
 * results. Likewise the read-time refusal chokepoints are A-1's
 * (account-api/auth/console/drip/usage/snapshot tests) — what is proven here is
 * that this route is the thing that finally SETS the column they read.
 *
 * The vault teardown is driven through the injected `vaultFetch` seam (no DO is
 * reachable in-test), so what these tests pin about storage is the CONTRACT:
 * that destroy is called, once per owned vault, with the confirm body and an
 * admin mint for that vault — and, critically, that the D1 ownership rows are
 * removed only when it succeeded.
 */
import { env } from "cloudflare:test";
import type Stripe from "stripe";
import { describe, expect, test } from "vitest";
import { ACCOUNT_TOKEN_AUDIENCE } from "../src/account-auth.ts";
import { handleAccountVaultsList } from "../src/account-api.ts";
import {
  ACCOUNT_PURGE_ALERT_AFTER_ATTEMPTS,
  DELETE_UNDO_WINDOW_MS,
  handleAccountDelete,
  handleAccountDeleteUndo,
  runAccountDeleteSweep,
} from "../src/account-delete.ts";
import { ACCOUNT_TOKEN_CLIENT_ID } from "../src/account-token.ts";
import type { BillingOverrides } from "../src/billing.ts";
import { sha256Hex } from "../src/crypto.ts";
import type { EmailSender, OpsEmail, SendResult } from "../src/email.ts";
import type { OAuthDeps } from "../src/oauth-shared.ts";
import { eligibleFor } from "../src/drip.ts";
import { DRIP_CRON, handleScheduled } from "../src/ops.ts";
import { findActiveSession } from "../src/sessions.ts";
import { signAccessToken } from "../src/tokens.ts";
import { getUserById } from "../src/users.ts";
import { ISSUER, db, decodeJwtPayload, deps, seedSession, seedUser, seedVault } from "./helpers.ts";

type VaultFetch = NonNullable<OAuthDeps["vaultFetch"]>;

/** A destroy call the vault worker would have received. */
interface DestroyCall {
  method: string;
  path: string;
  body: unknown;
  scope: string;
  audience: unknown;
}

/** The default vault seam: every destroy succeeds, and each call is recorded so
 *  a test can assert the contract (one call per owned vault, confirm body,
 *  vault-scoped admin mint) instead of merely that "something happened". */
function recordingVaultFetch(opts: { failFor?: Set<string> } = {}): {
  vaultFetch: VaultFetch;
  calls: DestroyCall[];
} {
  const calls: DestroyCall[] = [];
  const vaultFetch: VaultFetch = async (input, init) => {
    const req = new Request(input, init);
    const path = new URL(req.url).pathname;
    const body = await req.clone().json().catch(() => null);
    const token = req.headers.get("authorization")?.replace(/^Bearer\s+/, "") ?? "";
    const claims = token ? decodeJwtPayload(token) : {};
    calls.push({
      method: req.method,
      path,
      body,
      scope: String(claims.scope ?? ""),
      audience: claims.aud,
    });
    const name = String((body as { confirm?: string } | null)?.confirm ?? "");
    if (opts.failFor?.has(name)) return Response.json({ error: "busy" }, { status: 503 });
    return Response.json({ destroyed: true, r2_objects_deleted: 1 }, { status: 200 });
  };
  return { vaultFetch, calls };
}

function accountDeps(now?: () => Date, vaultFetch?: VaultFetch): OAuthDeps {
  return { ...deps(now), vaultFetch: vaultFetch ?? recordingVaultFetch().vaultFetch };
}

async function mintAccountToken(userId: string, verb: "admin" | "read" = "admin"): Promise<string> {
  const signed = await signAccessToken(db(), {
    sub: userId,
    scopes: [`account:${userId}:${verb}`],
    audience: ACCOUNT_TOKEN_AUDIENCE,
    clientId: ACCOUNT_TOKEN_CLIENT_ID,
    issuer: ISSUER,
    vaultScope: [],
    ttlSeconds: 600,
  });
  return signed.token;
}

function deleteReq(token: string | null, confirm?: unknown, method: "DELETE" | "POST" = "DELETE"): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request(`${ISSUER}/account/delete`, {
    method,
    headers,
    body: JSON.stringify(confirm === undefined ? {} : { confirm }),
  });
}

function undoGetReq(token: string): Request {
  return new Request(`${ISSUER}/account/undo-delete?token=${encodeURIComponent(token)}`);
}

function undoPostReq(body: unknown): Request {
  return new Request(`${ISSUER}/account/undo-delete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// --- the injected Stripe stub (billing-teardown.test.ts's seam) ---------------

interface StripeCalls {
  updated: Array<{ id: string; cancelAtPeriodEnd: boolean }>;
  canceled: string[];
  deletedCustomers: string[];
}

function makeStripeStub(opts: { hardFailUpdate?: boolean } = {}): { stripe: Stripe; calls: StripeCalls } {
  const calls: StripeCalls = { updated: [], canceled: [], deletedCustomers: [] };
  const stripe = {
    subscriptions: {
      update: async (id: string, params: { cancel_at_period_end?: boolean }) => {
        calls.updated.push({ id, cancelAtPeriodEnd: params.cancel_at_period_end ?? false });
        if (opts.hardFailUpdate) throw new Error("stripe is down");
        return { id, status: "active" };
      },
      cancel: async (id: string) => {
        calls.canceled.push(id);
        return { id, status: "canceled" };
      },
      list: async () => ({ object: "list", data: [], has_more: false, url: "/v1/subscriptions" }),
    },
    customers: {
      del: async (id: string) => {
        calls.deletedCustomers.push(id);
        return { id, object: "customer", deleted: true };
      },
    },
  } as unknown as Stripe;
  return { stripe, calls };
}

function billing(stripe: Stripe): BillingOverrides {
  return { stripe };
}

/** An EmailSender that records the deletion notice instead of sending it. */
function recordingSender(opts: { fail?: boolean } = {}): { sender: EmailSender; ops: OpsEmail[] } {
  const ops: OpsEmail[] = [];
  const sender: EmailSender = {
    kind: "devlog",
    async sendMagicLink(): Promise<SendResult> {
      return { ok: true };
    },
    async sendOps(msg: OpsEmail): Promise<SendResult> {
      ops.push(msg);
      return opts.fail ? { ok: false, error: "mailbox full" } : { ok: true };
    },
    async sendDrip(): Promise<SendResult> {
      return { ok: true };
    },
  };
  return { sender, ops };
}

// --- fixtures -----------------------------------------------------------------

const T0 = new Date("2026-08-10T00:00:00.000Z");
const clock = (d: Date) => () => d;
const plus = (ms: number) => new Date(T0.getTime() + ms);

interface Seeded {
  userId: string;
  email: string;
  token: string;
  sessionId: string;
}

/** A full account: bearer, live session, a live vault token, a consent grant,
 *  and (optionally) Stripe ids — i.e. one of every artifact the teardown owns. */
async function seedAccount(
  email: string,
  opts: { vaults?: string[]; stripe?: boolean; handle?: string } = {},
): Promise<Seeded> {
  const { id } = await seedUser(email);
  const token = await mintAccountToken(id);
  const sessionId = await seedSession(id);
  for (const name of opts.vaults ?? []) await seedVault(name, id);

  const expiresAt = new Date(T0.getTime() + 3_600_000).toISOString();
  await env.DB.batch([
    env.DB
      .prepare(
        "INSERT INTO tokens (jti, user_id, client_id, scopes, expires_at, revoked_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)",
      )
      .bind(`jti-${id}`, id, "some-client", `vault:${(opts.vaults ?? ["none"])[0]}:read`, expiresAt, T0.toISOString()),
    env.DB
      .prepare("INSERT INTO grants (user_id, client_id, scopes, granted_at) VALUES (?, ?, ?, ?)")
      .bind(id, "some-client", `vault:${(opts.vaults ?? ["none"])[0]}:read`, T0.toISOString()),
    env.DB
      .prepare("INSERT INTO user_checklist (user_id, item, done_at) VALUES (?, ?, ?)")
      .bind(id, "created-vault", T0.toISOString()),
  ]);

  if (opts.stripe) {
    await env.DB
      .prepare("UPDATE users SET stripe_customer_id = ?, stripe_subscription_id = ?, plan = 'standard' WHERE id = ?")
      .bind(`cus_${id}`, `sub_${id}`, id)
      .run();
  }
  if (opts.handle) {
    await env.DB
      .prepare("INSERT INTO owners (owner_id, handle, kind, claimed_at) VALUES (?, ?, 'user', ?)")
      .bind(`own_${id}`, opts.handle, T0.toISOString())
      .run();
    await env.DB.prepare("UPDATE users SET owner_id = ? WHERE id = ?").bind(`own_${id}`, id).run();
  }
  return { userId: id, email, token, sessionId };
}

async function countRows(table: string, column: string, value: string): Promise<number> {
  const row = await env.DB
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`)
    .bind(value)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Everything the teardown is supposed to remove, in one shot. */
async function residue(userId: string, vaultName: string) {
  return {
    user: (await getUserById(env.DB, userId)) !== null,
    vaults: await countRows("vaults", "owner_user_id", userId),
    vaultUsage: await countRows("vault_usage", "vault_name", vaultName),
    vaultSnapshots: await countRows("vault_snapshots", "vault_name", vaultName),
    sessions: await countRows("sessions", "user_id", userId),
    tokens: await countRows("tokens", "user_id", userId),
    grants: await countRows("grants", "user_id", userId),
    checklist: await countRows("user_checklist", "user_id", userId),
  };
}

/** The per-vault rollup/manifest rows the vault delete cascade owns. */
async function seedVaultMirrors(vaultName: string): Promise<void> {
  await env.DB.batch([
    env.DB
      .prepare("INSERT INTO vault_usage (vault_name, day, db_bytes, r2_bytes) VALUES (?, ?, ?, ?)")
      .bind(vaultName, "2026-08-09", 11, 22),
    env.DB
      .prepare("INSERT INTO vault_snapshots (vault_name, key, taken_at, bytes, ranks) VALUES (?, ?, ?, ?, ?)")
      .bind(vaultName, `vault-${vaultName}/snapshots/a.tar`, T0.toISOString(), 33, "[]"),
  ]);
}

// --- 1. the request ----------------------------------------------------------

describe("A-3 — DELETE /account/delete opens the undo window", () => {
  test("tombstones the account, holds billing reversibly, severs auth, and erases NOTHING", async () => {
    const acct = await seedAccount("req-happy@example.com", { vaults: ["keepsafe"], stripe: true });
    await seedVaultMirrors("keepsafe");
    const { stripe, calls } = makeStripeStub();
    const { sender, ops } = recordingSender();

    const res = await handleAccountDelete(
      env,
      deleteReq(acct.token, acct.email),
      accountDeps(clock(T0)),
      sender,
      billing(stripe),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.deleted).toBe(true);
    expect(body.deleted_at).toBe(T0.toISOString());
    expect(body.undo_expires_at).toBe(new Date(T0.getTime() + DELETE_UNDO_WINDOW_MS).toISOString());
    expect(body.notice_sent).toBe(true);
    expect(typeof body.undo_token).toBe("string");

    // The tombstone is real, and the stored undo secret is a HASH — the raw
    // token must never be at rest (it is mailed, and it restores an account).
    const user = await getUserById(env.DB, acct.userId);
    expect(user?.deletedAt).toBe(T0.toISOString());
    expect(user?.deleteNoticeSentAt).toBe(T0.toISOString());
    expect(user?.deleteUndoHash).toBe(await sha256Hex(String(body.undo_token)));
    expect(user?.deleteUndoHash).not.toBe(String(body.undo_token));

    // The hold is the REVERSIBLE one (cancel_at_period_end), never a cancel —
    // this is the whole point of the window. Goes red if the route ever calls
    // teardownBilling at request time.
    expect(calls.updated).toEqual([{ id: `sub_${acct.userId}`, cancelAtPeriodEnd: true }]);
    expect(calls.canceled).toEqual([]);
    expect(calls.deletedCustomers).toEqual([]);

    // Auth is severed NOW, not at the window's end.
    expect(await findActiveSession(env.DB, acct.sessionId, T0)).toBeNull();
    const live = await countRows("tokens", "user_id", acct.userId);
    const revoked = await env.DB
      .prepare("SELECT COUNT(*) AS n FROM tokens WHERE user_id = ? AND revoked_at IS NOT NULL")
      .bind(acct.userId)
      .first<{ n: number }>();
    expect(revoked?.n).toBe(live);

    // …and NOTHING has been erased. The vault, its mirrors, and the account
    // row all survive the request — only the sweep may remove them.
    expect(await residue(acct.userId, "keepsafe")).toMatchObject({
      user: true,
      vaults: 1,
      vaultUsage: 1,
      vaultSnapshots: 1,
    });

    // The notice carries the way back — a user who was just signed out
    // everywhere has no other route to undo.
    expect(ops).toHaveLength(1);
    expect(ops[0]!.to).toBe(acct.email);
    expect(ops[0]!.text).toContain(String(body.undo_url));
  });

  test("the severed bearer is dead on the very next call (A-1's chokepoint, now reachable)", async () => {
    const acct = await seedAccount("req-severed@example.com");
    const first = await handleAccountDelete(env, deleteReq(acct.token, acct.email), accountDeps(clock(T0)));
    expect(first.status).toBe(200);

    // The SAME bearer that just worked now gets the "account not found" shape —
    // indistinguishable from a missing row, by A-1's design.
    const second = await handleAccountDelete(env, deleteReq(acct.token, acct.email), accountDeps(clock(T0)));
    expect(second.status).toBe(401);
    expect((await second.json()) as unknown).toEqual({
      error: "invalid_token",
      error_description: "account not found",
    });
  });

  test("confirm must retype the account email, and a mismatch changes nothing", async () => {
    const acct = await seedAccount("req-confirm@example.com", { stripe: true });
    const { stripe, calls } = makeStripeStub();
    for (const bad of [undefined, "", "someone-else@example.com", 42]) {
      const res = await handleAccountDelete(
        env,
        deleteReq(acct.token, bad),
        accountDeps(clock(T0)),
        undefined,
        billing(stripe),
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("confirm_mismatch");
    }
    // Not one Stripe call, not one row touched — the confirm gate runs first.
    expect(calls.updated).toEqual([]);
    expect((await getUserById(env.DB, acct.userId))?.deletedAt).toBeNull();
    expect(await findActiveSession(env.DB, acct.sessionId, T0)).not.toBeNull();
  });

  test("case-insensitive confirm (the email column is NOCASE — the gate must agree)", async () => {
    const acct = await seedAccount("Req-Case@example.com");
    const res = await handleAccountDelete(
      env,
      deleteReq(acct.token, "  REQ-CASE@EXAMPLE.COM  "),
      accountDeps(clock(T0)),
    );
    expect(res.status).toBe(200);
  });

  test("401 unauthenticated and 403 for a read-scope bearer — both before any destruction", async () => {
    const { id } = await seedUser("req-scope@example.com");
    const readToken = await mintAccountToken(id, "read");

    const anon = await handleAccountDelete(env, deleteReq(null, "req-scope@example.com"), accountDeps(clock(T0)));
    expect(anon.status).toBe(401);

    const read = await handleAccountDelete(env, deleteReq(readToken, "req-scope@example.com"), accountDeps(clock(T0)));
    expect(read.status).toBe(403);
    expect((await getUserById(env.DB, id))?.deletedAt).toBeNull();
  });

  test("a hard billing failure aborts the request with nothing written", async () => {
    const acct = await seedAccount("req-billing-down@example.com", { stripe: true });
    const { stripe } = makeStripeStub({ hardFailUpdate: true });

    const res = await handleAccountDelete(
      env,
      deleteReq(acct.token, acct.email),
      accountDeps(clock(T0)),
      undefined,
      billing(stripe),
    );
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe("billing_hold_failed");
    // The hold is the FIRST step precisely so this case leaves no tombstone:
    // an account that still bills must not also be un-loggable-into.
    expect((await getUserById(env.DB, acct.userId))?.deletedAt).toBeNull();
    expect(await findActiveSession(env.DB, acct.sessionId, T0)).not.toBeNull();
  });

  test("a hold that is placed and then cannot be released pages the operator", async () => {
    // The compound failure: deferBilling succeeds, the tombstone write fails,
    // and resumeBilling ALSO fails. The subscription is left at
    // cancel_at_period_end on an account with NO tombstone — so no sweep will
    // ever revisit it and the user's subscription silently lapses. Nothing in
    // the product shows this; the alert is the only way it becomes work.
    const acct = await seedAccount("req-hold-stuck@example.com", { stripe: true });
    let updateCalls = 0;
    const oneWayStripe = {
      subscriptions: {
        update: async (_id: string, params: { cancel_at_period_end?: boolean }) => {
          updateCalls++;
          // The hold lands; the RELEASE is what fails.
          if (params.cancel_at_period_end === false) throw new Error("stripe is down");
          return { id: _id, status: "active" };
        },
      },
    } as unknown as Stripe;
    const { sender, ops } = recordingSender();
    const alertEnv = { ...env, OPERATOR_ALERT_EMAIL: "ops@example.com", ENVIRONMENT: "test-env" };

    // Fail the TOMBSTONE WRITE SPECIFICALLY. Dropping `users` would be caught
    // earlier, by requireAccount's own read, and never reach the code under
    // test — so block exactly the one UPDATE instead, with a trigger. (Isolated
    // per-test storage rolls this back.)
    await env.DB
      .prepare(
        "CREATE TRIGGER block_tombstone BEFORE UPDATE OF deleted_at ON users WHEN NEW.deleted_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'tombstone blocked'); END",
      )
      .run();

    const res = await handleAccountDelete(
      alertEnv,
      deleteReq(acct.token, acct.email),
      accountDeps(clock(T0)),
      sender,
      billing(oneWayStripe),
    );
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe("delete_request_failed");
    // Hold placed, release attempted and failed.
    expect(updateCalls).toBe(2);

    const alert = ops.find((m) => m.subject.includes("billing hold stuck"));
    expect(alert).toBeDefined();
    expect(alert!.to).toBe("ops@example.com");
    expect(alert!.text).toContain(acct.userId);
    expect(alert!.text).toContain(`sub_${acct.userId}`);
    // The operator needs to know this account is NOT deleted — that is what
    // makes it unreachable by every automatic path.
    expect(alert!.text).toContain("NOT deleted");
  });

  test("a failed notice email does not fail the deletion, and never claims it was sent", async () => {
    const acct = await seedAccount("req-mail-down@example.com");
    const { sender, ops } = recordingSender({ fail: true });
    const res = await handleAccountDelete(env, deleteReq(acct.token, acct.email), accountDeps(clock(T0)), sender);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { notice_sent: boolean }).notice_sent).toBe(false);
    expect(ops).toHaveLength(1);
    // The delete stands (it is already in effect), but the column stays NULL —
    // it must never assert an email that did not go out.
    const user = await getUserById(env.DB, acct.userId);
    expect(user?.deletedAt).toBe(T0.toISOString());
    expect(user?.deleteNoticeSentAt).toBeNull();
  });
});

// --- 2. the window -----------------------------------------------------------

describe("A-4 — inside the 24-hour window nothing is destroyed", () => {
  test("a sweep one second before expiry finds nothing due and leaves every artifact", async () => {
    const acct = await seedAccount("win-early@example.com", { vaults: ["patient"], stripe: true });
    await seedVaultMirrors("patient");
    const { stripe, calls } = makeStripeStub();
    await handleAccountDelete(env, deleteReq(acct.token, acct.email), accountDeps(clock(T0)), undefined, billing(stripe));

    const { vaultFetch, calls: destroys } = recordingVaultFetch();
    const summary = await runAccountDeleteSweep(
      env,
      accountDeps(undefined, vaultFetch),
      plus(DELETE_UNDO_WINDOW_MS - 1000),
      billing(stripe),
    );
    expect(summary).toEqual({ due: 0, purged: 0, deferred: 0, failed: 0 });
    expect(destroys).toEqual([]);
    expect(calls.canceled).toEqual([]);
    expect(await residue(acct.userId, "patient")).toMatchObject({
      user: true,
      vaults: 1,
      vaultUsage: 1,
      vaultSnapshots: 1,
    });
  });
});

// --- 3. undo -----------------------------------------------------------------

describe("A-3 — undo inside the window restores the account", () => {
  test("the emailed GET link restores the account and releases the billing hold", async () => {
    const acct = await seedAccount("undo-link@example.com", { vaults: ["restored"], stripe: true });
    const { stripe, calls } = makeStripeStub();
    const del = await handleAccountDelete(
      env,
      deleteReq(acct.token, acct.email),
      accountDeps(clock(T0)),
      undefined,
      billing(stripe),
    );
    const { undo_token } = (await del.json()) as { undo_token: string };

    const res = await handleAccountDeleteUndo(
      env,
      undoGetReq(undo_token),
      accountDeps(clock(plus(60 * 60 * 1000))),
      billing(stripe),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ restored: true, billing_resumed: true });

    // The tombstone AND the spent secret are both cleared — a restored account
    // must not keep a live undo token lying around.
    const user = await getUserById(env.DB, acct.userId);
    expect(user?.deletedAt).toBeNull();
    expect(user?.deleteUndoHash).toBeNull();
    expect(user?.deleteNoticeSentAt).toBeNull();

    // The hold was released, not re-applied, and nothing was ever canceled.
    expect(calls.updated).toEqual([
      { id: `sub_${acct.userId}`, cancelAtPeriodEnd: true },
      { id: `sub_${acct.userId}`, cancelAtPeriodEnd: false },
    ]);
    expect(calls.canceled).toEqual([]);

    // And the account works again: a fresh bearer passes the gate that refused
    // it a moment ago, and still owns its vault.
    const fresh = await mintAccountToken(acct.userId);
    const list = await handleAccountVaultsList(
      db(),
      new Request(`${ISSUER}/account/vaults`, { headers: { authorization: `Bearer ${fresh}` } }),
      accountDeps(),
    );
    expect(list.status).toBe(200);
    expect(((await list.json()) as { vaults: { name: string }[] }).vaults.map((v) => v.name)).toEqual(["restored"]);
  });

  // cloud#234: Stripe webhooks during the window skip the DO cap push.
  // Undo is what re-applies current plan entitlement so a checkout that
  // landed mid-window is not lost on restore.
  test("undo re-applies current plan entitlement to owned vaults (cloud#234)", async () => {
    const acct = await seedAccount("undo-caps@example.com", { vaults: ["restored-caps"], stripe: true });
    const { stripe } = makeStripeStub();
    const { vaultFetch, calls } = recordingVaultFetch();
    const del = await handleAccountDelete(
      env,
      deleteReq(acct.token, acct.email),
      accountDeps(clock(T0), vaultFetch),
      undefined,
      billing(stripe),
    );
    const { undo_token } = (await del.json()) as { undo_token: string };
    calls.length = 0;

    const res = await handleAccountDeleteUndo(
      env,
      undoGetReq(undo_token),
      accountDeps(clock(plus(60 * 60 * 1000)), vaultFetch),
      billing(stripe),
    );
    expect(res.status).toBe(200);
    const capPuts = calls.filter((c) => c.method === "PUT" && c.path.endsWith("/api/internal/config"));
    expect(capPuts, `undo vaultFetch calls: ${JSON.stringify(calls)}`).toHaveLength(1);
    expect(calls.some((c) => c.method === "POST" && c.path.includes("/destroy"))).toBe(false);
  });

  test("POST with a JSON body is the same door (API clients have no inbox)", async () => {
    const acct = await seedAccount("undo-post@example.com");
    const del = await handleAccountDelete(env, deleteReq(acct.token, acct.email), accountDeps(clock(T0)));
    const { undo_token } = (await del.json()) as { undo_token: string };

    const res = await handleAccountDeleteUndo(env, undoPostReq({ token: undo_token }), accountDeps(clock(plus(1000))));
    expect(res.status).toBe(200);
    expect((await getUserById(env.DB, acct.userId))?.deletedAt).toBeNull();
  });

  test("an un-resumable subscription restores the account but says so plainly", async () => {
    const acct = await seedAccount("undo-uncancelable@example.com", { stripe: true });
    // deferBilling succeeds; the period boundary then passes, so the resume
    // update hits Stripe's tolerable invalid-request shape — resumeBilling's
    // `already_canceled`. Swapped in AFTER the delete so only the undo sees it.
    const { stripe: holdStripe } = makeStripeStub();
    const del = await handleAccountDelete(
      env,
      deleteReq(acct.token, acct.email),
      accountDeps(clock(T0)),
      undefined,
      billing(holdStripe),
    );
    const { undo_token } = (await del.json()) as { undo_token: string };

    const StripeCtor = (await import("stripe")).default;
    const canceledStripe = {
      subscriptions: {
        update: async () => {
          throw new StripeCtor.errors.StripeInvalidRequestError({
            message: "cannot update a canceled subscription",
            statusCode: 400,
          });
        },
      },
    } as unknown as Stripe;

    const res = await handleAccountDeleteUndo(
      env,
      undoPostReq({ token: undo_token }),
      accountDeps(clock(plus(1000))),
      billing(canceledStripe),
    );
    expect(res.status).toBe(200);
    // The account comes back — the data is theirs regardless — but the caller
    // is told billing did not, instead of discovering it on a failed feature.
    expect(await res.json()).toEqual({ restored: true, billing_resumed: false, billing_note: "already_canceled" });
    expect((await getUserById(env.DB, acct.userId))?.deletedAt).toBeNull();
  });

  test("a hard billing failure leaves the account deleted and the window open", async () => {
    const acct = await seedAccount("undo-billing-down@example.com", { stripe: true });
    const { stripe: holdStripe } = makeStripeStub();
    const del = await handleAccountDelete(
      env,
      deleteReq(acct.token, acct.email),
      accountDeps(clock(T0)),
      undefined,
      billing(holdStripe),
    );
    const { undo_token } = (await del.json()) as { undo_token: string };

    const { stripe: brokenStripe } = makeStripeStub({ hardFailUpdate: true });
    const res = await handleAccountDeleteUndo(
      env,
      undoPostReq({ token: undo_token }),
      accountDeps(clock(plus(1000))),
      billing(brokenStripe),
    );
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe("billing_resume_failed");
    // Still deleted, and the token still works once Stripe recovers — a
    // half-restored account (auth back, billing unknown) is the bad outcome.
    expect((await getUserById(env.DB, acct.userId))?.deletedAt).toBe(T0.toISOString());
    const retry = await handleAccountDeleteUndo(
      env,
      undoPostReq({ token: undo_token }),
      accountDeps(clock(plus(2000))),
      billing(makeStripeStub().stripe),
    );
    expect(retry.status).toBe(200);
  });

  test("the undo token is single-use", async () => {
    const acct = await seedAccount("undo-once@example.com");
    const del = await handleAccountDelete(env, deleteReq(acct.token, acct.email), accountDeps(clock(T0)));
    const { undo_token } = (await del.json()) as { undo_token: string };

    expect((await handleAccountDeleteUndo(env, undoGetReq(undo_token), accountDeps(clock(plus(1000))))).status).toBe(200);
    const second = await handleAccountDeleteUndo(env, undoGetReq(undo_token), accountDeps(clock(plus(2000))));
    expect(second.status).toBe(400);
    expect(((await second.json()) as { error: string }).error).toBe("invalid_undo_token");
  });

  test("every unusable token gets ONE neutral answer — no oracle", async () => {
    const acct = await seedAccount("undo-neutral@example.com");
    // A live account's own id, a random string, an empty token, and a
    // never-issued one must be indistinguishable from each other.
    const bodies: unknown[] = [];
    for (const req of [
      undoPostReq({}),
      undoPostReq({ token: "" }),
      undoPostReq({ token: "not-a-real-token" }),
      undoPostReq({ token: acct.userId }),
      undoGetReq("nope"),
    ]) {
      const res = await handleAccountDeleteUndo(env, req, accountDeps(clock(T0)));
      expect(res.status).toBe(400);
      bodies.push(await res.json());
    }
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
  });

  test("past the window the token is refused with the honest 410, not the neutral 400", async () => {
    const acct = await seedAccount("undo-late@example.com");
    const del = await handleAccountDelete(env, deleteReq(acct.token, acct.email), accountDeps(clock(T0)));
    const { undo_token } = (await del.json()) as { undo_token: string };

    const res = await handleAccountDeleteUndo(
      env,
      undoGetReq(undo_token),
      accountDeps(clock(plus(DELETE_UNDO_WINDOW_MS))),
    );
    expect(res.status).toBe(410);
    expect(((await res.json()) as { error: string }).error).toBe("undo_window_expired");
    // Deliberately NOT neutral: this token was real, the holder is the account
    // holder, and "you're too late" is the only useful thing to tell them.
    expect((await getUserById(env.DB, acct.userId))?.deletedAt).toBe(T0.toISOString());
  });

  test("the boundary is exclusive at exactly 24h — one millisecond earlier still restores", async () => {
    const acct = await seedAccount("undo-boundary@example.com");
    const del = await handleAccountDelete(env, deleteReq(acct.token, acct.email), accountDeps(clock(T0)));
    const { undo_token } = (await del.json()) as { undo_token: string };
    const res = await handleAccountDeleteUndo(
      env,
      undoGetReq(undo_token),
      accountDeps(clock(plus(DELETE_UNDO_WINDOW_MS - 1))),
    );
    expect(res.status).toBe(200);
  });
});

// --- 4. convergence ----------------------------------------------------------

describe("A-4 — past the window the sweep really deletes", () => {
  test("tears down billing, destroys every owned vault, and purges the account", async () => {
    const acct = await seedAccount("purge-happy@example.com", {
      vaults: ["alpha", "beta"],
      stripe: true,
      handle: "purged-handle",
    });
    await seedVaultMirrors("alpha");
    await seedVaultMirrors("beta");
    const { stripe, calls } = makeStripeStub();
    await handleAccountDelete(env, deleteReq(acct.token, acct.email), accountDeps(clock(T0)), undefined, billing(stripe));

    const { vaultFetch, calls: destroys } = recordingVaultFetch();
    const summary = await runAccountDeleteSweep(
      env,
      accountDeps(undefined, vaultFetch),
      plus(DELETE_UNDO_WINDOW_MS),
      billing(stripe),
    );
    expect(summary).toEqual({ due: 1, purged: 1, deferred: 0, failed: 0 });

    // STORAGE: one destroy per owned vault, each an admin mint pinned to that
    // vault with the confirm body — the same contract the single-vault door
    // honors, because it is literally the same call.
    expect(destroys).toHaveLength(2);
    for (const name of ["alpha", "beta"]) {
      const call = destroys.find((c) => (c.body as { confirm: string }).confirm === name);
      expect(call).toBeDefined();
      expect(call!.method).toBe("POST");
      expect(call!.path).toContain("/api/internal/destroy");
      expect(call!.scope).toBe(`vault:${name}:admin`);
      expect(call!.audience).toBe(`vault.${name}`);
    }

    // BILLING: the real, irreversible teardown ran — cancel + delete-customer,
    // which the request path deliberately did NOT do.
    expect(calls.canceled).toEqual([`sub_${acct.userId}`]);
    expect(calls.deletedCustomers).toEqual([`cus_${acct.userId}`]);

    // ROWS: nothing of the account is left, in any table it touched.
    expect(await residue(acct.userId, "alpha")).toEqual({
      user: false,
      vaults: 0,
      vaultUsage: 0,
      vaultSnapshots: 0,
      sessions: 0,
      tokens: 0,
      grants: 0,
      checklist: 0,
    });
    expect(await countRows("vault_usage", "vault_name", "beta")).toBe(0);
    // The handle is RELEASED, not burned — a global namespace claim must not
    // outlive the account that made it.
    expect(await countRows("owners", "handle", "purged-handle")).toBe(0);
  });

  test("after the purge every read refuses — the bearer, the vault list, and the undo token", async () => {
    const acct = await seedAccount("purge-reads@example.com", { vaults: ["vanished"] });
    const del = await handleAccountDelete(env, deleteReq(acct.token, acct.email), accountDeps(clock(T0)));
    const { undo_token } = (await del.json()) as { undo_token: string };
    const fresh = await mintAccountToken(acct.userId);

    await runAccountDeleteSweep(env, accountDeps(), plus(DELETE_UNDO_WINDOW_MS));

    // A bearer minted while the account existed is now indistinguishable from
    // one for an account that never existed.
    const list = await handleAccountVaultsList(
      db(),
      new Request(`${ISSUER}/account/vaults`, { headers: { authorization: `Bearer ${fresh}` } }),
      accountDeps(),
    );
    expect(list.status).toBe(401);
    expect((await list.json()) as unknown).toEqual({
      error: "invalid_token",
      error_description: "account not found",
    });

    // The undo token is dead too — and gets the expired answer, not a 500 on a
    // row that no longer exists.
    const undo = await handleAccountDeleteUndo(
      env,
      undoGetReq(undo_token),
      accountDeps(clock(plus(DELETE_UNDO_WINDOW_MS + 1000))),
    );
    expect(undo.status).toBe(400);
    expect(await countRows("vaults", "name", "vanished")).toBe(0);
  });

  test("a vault whose destroy FAILS defers the whole account, and a later pass converges", async () => {
    const acct = await seedAccount("purge-stuck@example.com", { vaults: ["wedged", "fine"] });
    await seedVaultMirrors("wedged");
    await handleAccountDelete(env, deleteReq(acct.token, acct.email), accountDeps(clock(T0)));

    const failing = recordingVaultFetch({ failFor: new Set(["wedged"]) });
    const first = await runAccountDeleteSweep(
      env,
      accountDeps(undefined, failing.vaultFetch),
      plus(DELETE_UNDO_WINDOW_MS),
    );
    expect(first).toEqual({ due: 1, purged: 0, deferred: 1, failed: 0 });

    // The account row SURVIVES — it is the only thing that still says whose
    // the surviving vault is. The vault that did succeed is gone (destroy is
    // irreversible, so its rows must not be re-created), the wedged one stays.
    expect((await getUserById(env.DB, acct.userId))?.deletedAt).toBe(T0.toISOString());
    expect(await countRows("vaults", "name", "wedged")).toBe(1);
    expect(await countRows("vault_usage", "vault_name", "wedged")).toBe(1);
    expect(await countRows("vaults", "name", "fine")).toBe(0);

    // Next pass, DO healthy: converges, and does not re-destroy the vault that
    // already went (its ownership row is gone, so it is not enumerated).
    const healthy = recordingVaultFetch();
    const second = await runAccountDeleteSweep(
      env,
      accountDeps(undefined, healthy.vaultFetch),
      plus(DELETE_UNDO_WINDOW_MS + 3_600_000),
    );
    expect(second).toEqual({ due: 1, purged: 1, deferred: 0, failed: 0 });
    expect(healthy.calls.map((c) => (c.body as { confirm: string }).confirm)).toEqual(["wedged"]);
    expect(await residue(acct.userId, "wedged")).toMatchObject({ user: false, vaults: 0, vaultUsage: 0 });
  });

  test("billing that will not converge defers the account and never touches vault storage", async () => {
    const acct = await seedAccount("purge-billing-stuck@example.com", { vaults: ["untouched"], stripe: true });
    const { stripe: holdStripe } = makeStripeStub();
    await handleAccountDelete(
      env,
      deleteReq(acct.token, acct.email),
      accountDeps(clock(T0)),
      undefined,
      billing(holdStripe),
    );

    // teardownBilling catches its own failures and answers unconverged.
    const brokenStripe = {
      subscriptions: {
        cancel: async () => {
          throw new Error("stripe is down");
        },
        list: async () => ({ object: "list", data: [], has_more: false, url: "/v1/subscriptions" }),
      },
      customers: { del: async () => ({ deleted: true }) },
    } as unknown as Stripe;

    const { vaultFetch, calls: destroys } = recordingVaultFetch();
    const summary = await runAccountDeleteSweep(
      env,
      accountDeps(undefined, vaultFetch),
      plus(DELETE_UNDO_WINDOW_MS),
      billing(brokenStripe),
    );
    expect(summary).toEqual({ due: 1, purged: 0, deferred: 1, failed: 0 });
    // Money first, and it stops the pass: destroying the data while a
    // subscription may still be billing for it is the worst ordering.
    expect(destroys).toEqual([]);
    expect(await countRows("vaults", "name", "untouched")).toBe(1);
    expect((await getUserById(env.DB, acct.userId))?.deletedAt).toBe(T0.toISOString());
  });

  test("one wedged account does not block the rest of the queue", async () => {
    const stuck = await seedAccount("purge-iso-stuck@example.com", { vaults: ["stuckvault"] });
    const ok = await seedAccount("purge-iso-ok@example.com", { vaults: ["okvault"] });
    await handleAccountDelete(env, deleteReq(stuck.token, stuck.email), accountDeps(clock(T0)));
    await handleAccountDelete(env, deleteReq(ok.token, ok.email), accountDeps(clock(new Date(T0.getTime() + 1000))));

    const { vaultFetch } = recordingVaultFetch({ failFor: new Set(["stuckvault"]) });
    const summary = await runAccountDeleteSweep(
      env,
      accountDeps(undefined, vaultFetch),
      plus(DELETE_UNDO_WINDOW_MS + 2000),
    );
    expect(summary).toEqual({ due: 2, purged: 1, deferred: 1, failed: 0 });
    expect((await getUserById(env.DB, stuck.userId)) !== null).toBe(true);
    expect((await getUserById(env.DB, ok.userId)) === null).toBe(true);
  });

  test.each([
    ["destroyed:false", { destroyed: false, r2_objects_deleted: 0 }],
    ["no destroyed field", { ok: true }],
    ["r2_objects_deleted missing", { destroyed: true }],
    ["r2_objects_deleted negative", { destroyed: true, r2_objects_deleted: -1 }],
    ["r2_objects_deleted fractional", { destroyed: true, r2_objects_deleted: 2.5 }],
  ] as const)(
    "a 200 that is not the DO's real reply (%s) defers instead of deleting the rows",
    async (kind, body) => {
      // THE ORPHAN CASE. The sweep used to check only `res.ok`, then delete the
      // D1 rows — which are the only record of whose bytes a vault held. A 200
      // from anything other than the real handler would have left the storage
      // billed, unattributable, and unreachable by any retry.
      const acct = await seedAccount(`purge-liar-${kind.replace(/[^a-z0-9]+/gi, "-")}@example.com`, {
        vaults: ["notreallygone"],
      });
      await seedVaultMirrors("notreallygone");
      await handleAccountDelete(env, deleteReq(acct.token, acct.email), accountDeps(clock(T0)));

      const liar: VaultFetch = async () => Response.json(body, { status: 200 });
      const summary = await runAccountDeleteSweep(
        env,
        accountDeps(undefined, liar),
        plus(DELETE_UNDO_WINDOW_MS),
      );
      expect(summary).toEqual({ due: 1, purged: 0, deferred: 1, failed: 0 });
      // Everything that names the vault survives, so a later real destroy can
      // still find it.
      expect(await countRows("vaults", "name", "notreallygone")).toBe(1);
      expect(await countRows("vault_usage", "vault_name", "notreallygone")).toBe(1);
      expect((await getUserById(env.DB, acct.userId))?.deletedAt).toBe(T0.toISOString());
    },
  );

  test("an unparseable 200 body also defers", async () => {
    const acct = await seedAccount("purge-unparseable@example.com", { vaults: ["garbled"] });
    await handleAccountDelete(env, deleteReq(acct.token, acct.email), accountDeps(clock(T0)));
    const liar: VaultFetch = async () => new Response("not json", { status: 200 });
    const summary = await runAccountDeleteSweep(env, accountDeps(undefined, liar), plus(DELETE_UNDO_WINDOW_MS));
    expect(summary).toEqual({ due: 1, purged: 0, deferred: 1, failed: 0 });
    expect(await countRows("vaults", "name", "garbled")).toBe(1);
  });

  test("each failed pass increments the attempt counter, and past the threshold it pages the operator", async () => {
    const acct = await seedAccount("purge-escalate@example.com", { vaults: ["forever-wedged"] });
    await handleAccountDelete(env, deleteReq(acct.token, acct.email), accountDeps(clock(T0)));
    const { vaultFetch } = recordingVaultFetch({ failFor: new Set(["forever-wedged"]) });
    const { sender, ops } = recordingSender();
    const alertEnv = { ...env, OPERATOR_ALERT_EMAIL: "ops@example.com", ENVIRONMENT: "test-env" };

    // Wind the counter to one below the threshold, then take the two passes
    // that straddle it — the second is the one that must escalate.
    await env.DB
      .prepare("UPDATE users SET delete_purge_attempts = ? WHERE id = ?")
      .bind(ACCOUNT_PURGE_ALERT_AFTER_ATTEMPTS - 2, acct.userId)
      .run();

    const quiet = await runAccountDeleteSweep(
      alertEnv,
      accountDeps(undefined, vaultFetch),
      plus(DELETE_UNDO_WINDOW_MS),
      { sender },
    );
    expect(quiet.deferred).toBe(1);
    expect((await getUserById(env.DB, acct.userId))?.deletePurgeAttempts).toBe(
      ACCOUNT_PURGE_ALERT_AFTER_ATTEMPTS - 1,
    );
    // Below the threshold the operator is NOT woken — otherwise a transient
    // fault would page on its first pass and train them to ignore it.
    expect(ops).toHaveLength(0);

    const loud = await runAccountDeleteSweep(
      alertEnv,
      accountDeps(undefined, vaultFetch),
      plus(DELETE_UNDO_WINDOW_MS + 3_600_000),
      { sender },
    );
    expect(loud.deferred).toBe(1);
    expect((await getUserById(env.DB, acct.userId))?.deletePurgeAttempts).toBe(
      ACCOUNT_PURGE_ALERT_AFTER_ATTEMPTS,
    );
    expect(ops).toHaveLength(1);
    expect(ops[0]!.to).toBe("ops@example.com");
    expect(ops[0]!.subject).toContain("account deletion stuck");
    // The alert must carry the account id — an operator cannot act on "an
    // account somewhere is stuck".
    expect(ops[0]!.text).toContain(acct.userId);
    // …and must say the data is still there, which is the whole reason it is
    // an email and not a log line.
    expect(ops[0]!.text).toContain("STILL PRESENT");

    // Dedupe: another pass inside the hour does not re-page.
    await runAccountDeleteSweep(
      alertEnv,
      accountDeps(undefined, vaultFetch),
      plus(DELETE_UNDO_WINDOW_MS + 3_600_000 + 60_000),
      { sender },
    );
    expect(ops).toHaveLength(1);
  });

  test("a converging account never accrues attempts", async () => {
    // The negative control for the counter: if it incremented on success, the
    // escalation above would eventually page for healthy deletions.
    const acct = await seedAccount("purge-noattempts@example.com", { vaults: ["smooth"] });
    await handleAccountDelete(env, deleteReq(acct.token, acct.email), accountDeps(clock(T0)));
    const summary = await runAccountDeleteSweep(env, accountDeps(), plus(DELETE_UNDO_WINDOW_MS));
    expect(summary).toEqual({ due: 1, purged: 1, deferred: 0, failed: 0 });
    expect(await getUserById(env.DB, acct.userId)).toBeNull();
  });

  test("a live (never-deleted) account is invisible to the sweep — the negative control", async () => {
    const live = await seedAccount("purge-control@example.com", { vaults: ["safe"] });
    const { vaultFetch, calls } = recordingVaultFetch();
    const summary = await runAccountDeleteSweep(
      env,
      accountDeps(undefined, vaultFetch),
      plus(DELETE_UNDO_WINDOW_MS * 10),
    );
    expect(summary).toEqual({ due: 0, purged: 0, deferred: 0, failed: 0 });
    expect(calls).toEqual([]);
    expect((await getUserById(env.DB, live.userId)) !== null).toBe(true);
    expect(await countRows("vaults", "name", "safe")).toBe(1);
  });

  test("a throwing drip does not starve the sweep on the same tick", async () => {
    // The drip runs FIRST on the hourly tick. Unguarded, a permanently
    // throwing drip meant no deleted account was ever purged — the promise in
    // the deletion email quietly never kept, with nothing failing loudly.
    const acct = await seedAccount("purge-drip-throws@example.com");
    await handleAccountDelete(env, deleteReq(acct.token, acct.email), accountDeps(clock(T0)));

    // A sender whose drip send throws (rather than returning !ok) is the
    // cheapest way to make runDrip itself reject through the seam it owns.
    const exploding: EmailSender = {
      kind: "devlog",
      async sendMagicLink(): Promise<SendResult> {
        return { ok: true };
      },
      async sendOps(): Promise<SendResult> {
        return { ok: true };
      },
      async sendDrip(): Promise<SendResult> {
        throw new Error("drip is broken");
      },
    };
    // A LIVE, welcome-window arrival, so runDrip actually reaches the sender
    // and throws. It cannot be the deleted account: A-1 excludes a tombstoned
    // row from every drip eligibility query, so a deleted user is by
    // construction never drip-eligible. (This is precisely how the first
    // version of this test came out vacuous — the mutation that removes the
    // guard passed it, because the sender was never called at all.)
    const tick = plus(DELETE_UNDO_WINDOW_MS);
    const live = await seedUser("purge-drip-live@example.com");
    await env.DB
      .prepare("UPDATE users SET created_at = ? WHERE id = ?")
      .bind(new Date(tick.getTime() - 60_000).toISOString(), live.id)
      .run();
    // Control: the drip really is about to fire for this user.
    expect((await eligibleFor(env.DB, "welcome", tick, 5)).map((u) => u.id)).toContain(live.id);

    await handleScheduled(DRIP_CRON, env, exploding, { now: () => tick });
    // The tick survived the drip's exception and the sweep still ran.
    expect(await getUserById(env.DB, acct.userId)).toBeNull();
  });

  test("the sweep is actually ON the hourly cron — not merely exported", async () => {
    // Without this, every assertion above would hold against a function no
    // deployment ever calls. Drives the real scheduled entrypoint.
    const acct = await seedAccount("purge-cron@example.com");
    await handleAccountDelete(env, deleteReq(acct.token, acct.email), accountDeps(clock(T0)));

    await handleScheduled(DRIP_CRON, env, recordingSender().sender, {
      now: () => plus(DELETE_UNDO_WINDOW_MS),
    });
    expect(await getUserById(env.DB, acct.userId)).toBeNull();
  });
});
