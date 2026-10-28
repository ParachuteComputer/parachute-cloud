/**
 * T-318 open beta, IDENTITY side. Runs in the `identity-open-beta` project
 * (BILLING_MODE="open_beta" — the deployed default; vitest.config.ts), against
 * real D1 through the real worker fetch. The paid path keeps its own coverage
 * in the main `identity` project (BILLING_MODE="paid").
 *
 *   (a) a new sign-up has no clock, and the sweep never floors or freezes it,
 *       even long after the old 90-day clock would have struck;
 *   (a') a row already `expired` reads as the beta and pushes frozen:false;
 *   (c) checkout / account checkout / promo / tier pick refuse with
 *       billing_paused even WITH Stripe keys present; /account/summary says
 *       billing_enabled:false + billing_mode; an existing paying subscriber
 *       keeps the portal;
 *   (d) the lift's dry-run counts, apply, idempotence and rollback.
 */
import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import app from "../../src/index.ts";
import { ACCOUNT_TOKEN_AUDIENCE } from "../../src/account-auth.ts";
import { ACCOUNT_TOKEN_CLIENT_ID } from "../../src/account-token.ts";
import { runBillingSweep } from "../../src/billing-lifecycle.ts";
import {
  applyOpenBetaLift,
  countOpenBetaLift,
  liftRollbackSql,
  readLiftBackup,
} from "../../src/open-beta-lift.ts";
import { OPEN_BETA_LONG, OPEN_BETA_SHORT } from "../../src/plans.ts";
import { signAccessToken } from "../../src/tokens.ts";
import { applyPlanToVaults } from "../../src/vault-call.ts";
import { getUserByEmail, getUserById } from "../../src/users.ts";
import { CANONICAL_ORIGIN, CSRF, ISSUER, deps, seedSession, seedUser, seedVault } from "../helpers.ts";

/** env + a full Stripe config: the point is that open beta ignores it. */
const STRIPE_ENV = {
  ...env,
  STRIPE_SECRET_KEY: "sk_test_dummy_for_constructor",
  STRIPE_WEBHOOK_SECRET: "whsec_test_open_beta",
  STRIPE_PRICE_ENTRY_QUARTERLY: "price_e_q",
  STRIPE_PRICE_STANDARD_MONTHLY: "price_s_m",
  STRIPE_PRICE_PLUS_MONTHLY: "price_p_m",
  STRIPE_PRICE_POWER_MONTHLY: "price_w_m",
};

const DAY = 86_400_000;

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

async function accountToken(userId: string, verb: "admin" | "read"): Promise<string> {
  const signed = await signAccessToken(env.DB, {
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

function bearer(method: string, path: string, token: string, body?: unknown): Request {
  return new Request(`${ISSUER}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** deps() whose vaultFetch records every entitlement push body. */
function recordingDeps(now?: () => Date) {
  const pushes: Array<{ frozen: boolean; transcription: { enabled: boolean } }> = [];
  const d = {
    ...deps(now),
    vaultFetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      pushes.push(JSON.parse(String(init?.body ?? "null")));
      return Response.json({ ok: true });
    },
  };
  return { d, pushes };
}

describe("(a) a new sign-up in open beta has no clock and is never frozen", () => {
  test("real POST /signup → clockless trial; the sweep 200 days later changes nothing", async () => {
    const res = await app.fetch(
      post("/signup", { __csrf: CSRF, email: "beta-signup@example.com", password: "longenough1" }, `parachute_id_csrf=${CSRF}`),
      env,
    );
    expect(res.status).toBe(302);
    const user = await getUserByEmail(env.DB, "beta-signup@example.com");
    expect(user!.plan).toBe("trial");
    expect(user!.pendingPlan).toBeNull();
    expect(user!.planDowngradeAt).toBeNull();
    await seedVault("beta-signup-box", user!.id);

    // Long after the old 90-day clock: the sweep finds nothing due for them.
    const later = new Date(Date.now() + 200 * DAY);
    const { d, pushes } = recordingDeps(() => later);
    await runBillingSweep(env.DB, d, later);
    const after = await getUserById(env.DB, user!.id);
    expect(after!.plan).toBe("trial");
    expect(pushes).toHaveLength(0);

    // And the entitlement their vaults get is never frozen, voice on.
    await applyPlanToVaults(env.DB, d, user!.id);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.frozen).toBe(false);
    expect(pushes[0]!.transcription.enabled).toBe(true);
  });

  test("a row still carrying an OLD trial clock is landed on the beta by the sweep, never floored", async () => {
    const { id } = await seedUser("beta-oldclock@example.com");
    await seedVault("beta-oldclock-box", id);
    await env.DB.prepare("UPDATE users SET pending_plan = 'expired', plan_downgrade_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 60_000).toISOString(), id)
      .run();
    const { d, pushes } = recordingDeps();
    const summary = await runBillingSweep(env.DB, d, new Date());
    expect(summary.applied).toBe(1);
    const user = await getUserById(env.DB, id);
    expect(user!.plan).toBe("trial");
    expect(user!.pendingPlan).toBeNull();
    expect(user!.planDowngradeAt).toBeNull();
    expect(pushes[0]!.frozen).toBe(false);
  });

  test("a cancelled subscriber past their paid-through date lands on the beta, not the floor", async () => {
    const { id } = await seedUser("beta-churn@example.com");
    await env.DB.prepare(
      "UPDATE users SET plan = 'standard', stripe_subscription_id = 'sub_gone', pending_plan = 'expired', plan_downgrade_at = ? WHERE id = ?",
    )
      .bind(new Date(Date.now() - 60_000).toISOString(), id)
      .run();
    await runBillingSweep(env.DB, recordingDeps().d, new Date());
    expect((await getUserById(env.DB, id))!.plan).toBe("trial");
  });
});

describe("(a') an account frozen before the switch reads as the beta", () => {
  test("expired row → summary says Open beta, pushes frozen:false, console shows the money story and lets them create vaults", async () => {
    const { id } = await seedUser("beta-frozen@example.com");
    await env.DB.prepare("UPDATE users SET plan = 'expired', pending_plan = NULL, plan_downgrade_at = NULL WHERE id = ?")
      .bind(id)
      .run();
    await seedVault("beta-frozen-box", id);

    const { d, pushes } = recordingDeps();
    await applyPlanToVaults(env.DB, d, id);
    expect(pushes[0]!.frozen).toBe(false);

    const token = await accountToken(id, "read");
    const summary = (await (await app.fetch(bearer("GET", "/account/summary", token), STRIPE_ENV)).json()) as {
      plan: { tier: string; label: string; trial_days_left?: number };
      billing_enabled: boolean;
      billing_mode: string;
      money_story: string;
    };
    expect(summary.plan.tier).toBe("trial");
    expect(summary.plan.label).toBe("Open beta");
    expect(summary.plan.trial_days_left).toBeUndefined();
    expect(summary.billing_mode).toBe("open_beta");
    expect(summary.billing_enabled).toBe(false); // even with Stripe keys present
    expect(summary.money_story).toBe(OPEN_BETA_LONG);

    const session = await seedSession(id);
    const html = await (
      await app.fetch(new Request(`${CANONICAL_ORIGIN}/console`, { headers: { cookie: sessionCookie(session) } }), STRIPE_ENV)
    ).text();
    expect(html).toContain('data-testid="open-beta-story"');
    expect(html).toContain(OPEN_BETA_LONG.replace(/'/g, "&#39;"));
    expect(html).toContain("Free during the open beta.");
    for (const gone of ["Trial ended", "days left", "Subscribe", "Have a code?", "Try this free", "$1/mo", "plan-card-"]) {
      expect(html).not.toContain(gone);
    }
    // The zero-vault floor is gone: the create form renders, not the at-cap wall.
    expect(html).toContain('action="/console/vaults"');
  });
});

describe("(c) Stripe is dormant in open beta, even with keys", () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });
  afterEach(() => fetchMock.assertNoPendingInterceptors());

  test("POST /billing/checkout → 409 billing_paused with the long money story (no Stripe call)", async () => {
    const { id } = await seedUser("beta-checkout@example.com");
    const session = await seedSession(id);
    const res = await app.fetch(post("/billing/checkout", { __csrf: CSRF, plan: "plus" }, sessionCookie(session)), STRIPE_ENV);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "billing_paused", message: OPEN_BETA_LONG });
  });

  test("POST /account/billing/checkout → 409 billing_paused", async () => {
    const { id } = await seedUser("beta-acct-checkout@example.com");
    const res = await app.fetch(
      bearer("POST", "/account/billing/checkout", await accountToken(id, "admin"), { tier: "plus" }),
      STRIPE_ENV,
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("billing_paused");
  });

  test("portal: refused for a non-subscriber, OPEN for an existing paying subscriber", async () => {
    const { id: trialId } = await seedUser("beta-portal-trial@example.com");
    const refused = await app.fetch(bearer("POST", "/account/billing/portal", await accountToken(trialId, "admin")), STRIPE_ENV);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toBe("billing_paused");

    const { id: payingId } = await seedUser("beta-portal-paying@example.com");
    await env.DB.prepare(
      "UPDATE users SET plan = 'plus', stripe_customer_id = 'cus_paying', stripe_subscription_id = 'sub_paying', pending_plan = NULL, plan_downgrade_at = NULL WHERE id = ?",
    )
      .bind(payingId)
      .run();
    fetchMock
      .get("https://api.stripe.com")
      .intercept({ path: "/v1/billing_portal/sessions", method: "POST" })
      .reply(200, { id: "bps_1", object: "billing_portal.session", url: "https://billing.stripe.com/p/session/x" }, {
        headers: { "content-type": "application/json" },
      });
    const open = await app.fetch(bearer("POST", "/account/billing/portal", await accountToken(payingId, "admin")), STRIPE_ENV);
    expect(open.status).toBe(200);
  });

  test("promo redemption and the tier picker refuse without claiming anything", async () => {
    const { id } = await seedUser("beta-promo@example.com");
    const session = await seedSession(id);
    await env.DB.prepare(
      "INSERT INTO promo_codes (code, comp_days, max_redemptions, redeemed_count, active, created_at) VALUES ('BETATEST', 90, 10, 0, 1, ?)",
    )
      .bind(new Date().toISOString())
      .run();
    const promo = await app.fetch(post("/console/promo", { __csrf: CSRF, code: "BETATEST" }, sessionCookie(session)), env);
    expect(promo.status).toBe(302);
    expect(promo.headers.get("location")).toContain("promo_err=paused");
    const row = await env.DB.prepare("SELECT redeemed_count FROM promo_codes WHERE code = 'BETATEST'").first<{
      redeemed_count: number;
    }>();
    expect(row!.redeemed_count).toBe(0);

    const pick = await app.fetch(post("/console/plan", { __csrf: CSRF, plan: "power" }, sessionCookie(session)), env);
    expect(pick.headers.get("location")).toContain("plan_err=paused");
    expect((await getUserById(env.DB, id))!.pendingPlan).toBeNull();
  });

  test("the door descriptor publishes no prices, and the money line", async () => {
    const res = await app.fetch(new Request(`${ISSUER}/.well-known/parachute-account`), STRIPE_ENV);
    const body = (await res.json()) as { plans: unknown[]; billing_mode: string; money_line: string };
    expect(body.plans).toEqual([]);
    expect(body.billing_mode).toBe("open_beta");
    expect(body.money_line).toBe(OPEN_BETA_SHORT);
  });
});

describe("(d) the lift: dry-run counts, apply, idempotence, rollback", () => {
  test("counts every bucket, lifts only trial/expired, leaves paid alone, and rolls back", async () => {
    const at = (days: number) => new Date(Date.now() + days * DAY).toISOString();
    const seed = async (email: string, sql: string, ...binds: unknown[]) => {
      const { id } = await seedUser(email);
      await env.DB.prepare(sql).bind(...binds, id).run();
      return id;
    };
    // Two clockless beta sign-ups (seedUser in this project = no clock).
    await seedUser("lift-beta1@example.com");
    await seedUser("lift-beta2@example.com");
    const clocked = await seed("lift-clock@example.com", "UPDATE users SET pending_plan = 'expired', plan_downgrade_at = ? WHERE id = ?", at(20));
    const entryPick = await seed("lift-entry@example.com", "UPDATE users SET pending_plan = 'entry', plan_downgrade_at = ? WHERE id = ?", at(5));
    const powerPick = await seed("lift-power@example.com", "UPDATE users SET pending_plan = 'power', plan_downgrade_at = ? WHERE id = ?", at(5));
    const frozen = await seed("lift-frozen@example.com", "UPDATE users SET plan = 'expired', pending_plan = NULL, plan_downgrade_at = NULL WHERE id = ?");
    await seedVault("lift-frozen-a", frozen);
    await seedVault("lift-frozen-b", frozen);
    const paying = await seed(
      "lift-paying@example.com",
      "UPDATE users SET plan = 'plus', stripe_subscription_id = 'sub_x', pending_plan = NULL, plan_downgrade_at = NULL WHERE id = ?",
    );
    await seed(
      "lift-cancelling@example.com",
      "UPDATE users SET plan = 'standard', stripe_subscription_id = 'sub_y', pending_plan = 'expired', plan_downgrade_at = ? WHERE id = ?",
      at(10),
    );
    await seed("lift-comp@example.com", "UPDATE users SET plan = 'power', pending_plan = NULL, plan_downgrade_at = NULL WHERE id = ?");
    await seed("lift-deleted@example.com", "UPDATE users SET plan = 'expired', deleted_at = ? WHERE id = ?", at(0));

    const before = await countOpenBetaLift(env.DB);
    expect(before).toEqual({
      accounts: 9, // the deleted row is not counted
      trialing: 5,
      trial_with_clock: 3,
      trial_trying_power: 1,
      expired_frozen: 1,
      frozen_vaults: 2,
      paid_subscribers: 2,
      paid_subscribers_cancelling: 1,
      comped: 1,
      comped_with_end_date: 0,
      unknown_plan: 0,
      to_lift: 4, // clocked, entryPick, powerPick, frozen
    });

    const backup = await readLiftBackup(env.DB);
    expect(backup.map((r) => r.id).sort()).toEqual([clocked, entryPick, powerPick, frozen].sort());

    const changes = await applyOpenBetaLift(env.DB);
    expect(changes).toEqual([1, 3]);
    const after = await countOpenBetaLift(env.DB);
    expect(after.expired_frozen).toBe(0);
    expect(after.trial_with_clock).toBe(0);
    expect(after.trialing).toBe(6);
    expect(after.trial_trying_power).toBe(1); // Power kept — nobody shrinks
    expect(after.paid_subscribers).toBe(2); // untouched
    expect(after.to_lift).toBe(0);
    expect((await getUserById(env.DB, entryPick))!.pendingPlan).toBeNull();
    expect((await getUserById(env.DB, paying))!.plan).toBe("plus");

    // Idempotent.
    expect(await applyOpenBetaLift(env.DB)).toEqual([0, 0]);

    // Rollback restores exactly the backed-up rows.
    await env.DB.batch(liftRollbackSql(backup).map((sql) => env.DB.prepare(sql)));
    expect(await countOpenBetaLift(env.DB)).toEqual(before);
  }, 60_000); // eleven password-hashed seed users — slow on a shared box

  test("rollback SQL refuses a backup row with an odd shape instead of writing it", () => {
    expect(() =>
      liftRollbackSql([{ id: "x'; DROP TABLE users; --", plan: "trial", pending_plan: null, plan_downgrade_at: null }]),
    ).toThrow();
    expect(() => liftRollbackSql([{ id: "abc", plan: "gold", pending_plan: null, plan_downgrade_at: null }])).toThrow();
  });
});
