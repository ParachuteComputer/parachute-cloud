/**
 * Promo-code redemption (July 4th launch) — a free account redeems a code
 * (`INDEPENDENCE` / `INTERDEPENDENCE`) and gets a time-limited comp of the
 * paid plan. PURE COMP MACHINERY: no Stripe anywhere on this path (it works
 * in production before the keys land — it grants only a plan period, mints
 * nothing, charges nothing), so there is deliberately NO env/config gate.
 *
 * THE GRANT RIDES THE EXISTING PLAN MACHINERY, not a parallel system:
 *   - plan → PROMO_COMP_PLAN (Plus) + applyPlanToVaults (caps lift immediately
 *     — the exact seam checkout.session.completed / the admin comp lever call);
 *   - expiry = the deferred-downgrade pair (migration 0012): pending_plan =
 *     'expired' + plan_downgrade_at = now + comp_days. The hourly billing sweep
 *     (billing-lifecycle.ts runBillingSweep — rides DRIP_CRON, NOT gated on
 *     Stripe config) applies it when due: plan to the expired floor, caps +
 *     frozen pushed, DATA NEVER DELETED (writes freeze; reads/export untouched;
 *     extra vaults are grandfathered — only NEW creation refuses).
 *   - a comped user who later subscribes for real is safe: the checkout
 *     webhook's CAS write clears pending_plan + plan_downgrade_at, so a real
 *     subscription is never clawed back by a stale comp expiry.
 *
 * RACE-SAFETY BY CONSTRUCTION (the #72 CAS lesson):
 *   1. the slot claim is ONE conditional UPDATE (`redeemed_count + 1 WHERE
 *      active AND redeemed_count < max_redemptions`) — D1/SQLite executes it
 *      atomically, so N concurrent redeemers of the last slot produce exactly
 *      one `changes === 1`;
 *   2. one-promo-per-account is the `promo_redemptions` PRIMARY KEY(user_id)
 *      — a concurrent double-redeem loses at the INSERT, and the loser gives
 *      the claimed slot back (counter decrement) before answering friendly;
 *   3. the grant itself is a CAS on "still trial/expired" (`WHERE plan IN
 *      ('trial','expired')`) — if a real payment landed between our read and
 *      our write it flipped the plan to a paid TIER, so the comp unwinds
 *      completely instead of stomping a paying customer's row. The plan guard
 *      alone is right: every path that records a live subscription
 *      (checkout-completed's CAS, subscription.updated) flips the plan to a paid
 *      tier in the same write, while a CHURNED subscriber falls back to the
 *      expired floor keeping a stale stripe_subscription_id (the sweep never
 *      clears it) — hence the redeem gate keys on canStartCheckout, which is
 *      PLAN-ONLY (trial|expired): a stale id must NOT block redemption (#73).
 *
 * TRUST BOUNDARY: session + CSRF + same-origin — the console's write
 * boundary, exactly like /billing/checkout and /console/vaults (cookie
 * surface, never bearer). Feedback rides /console query params as allowlisted
 * CODES (console.ts PROMO_ERRORS — the admin.ts pattern).
 */
import { verifyCsrfToken } from "./csrf.ts";
import { sessionUser } from "./session-user.ts";
import { type OAuthDeps, isSameOriginRequest, redirectResponse, resolveBoundOrigins } from "./oauth-shared.ts";
import { type PlanId, canStartCheckout } from "./plans.ts";
import { applyPlanToVaults } from "./vault-call.ts";

/** The plan a promo comp grants — the launch codes are the GENEROUS comp, so
 *  they land on Plus (the full trial-equivalent experience: voice + attachments),
 *  redeemable FROM a trial (a comp just extends the runway). One place, so copy
 *  + grant can't drift. */
export const PROMO_COMP_PLAN: PlanId = "plus";

/** Codes are short human strings; refuse absurd input before touching D1. */
const MAX_CODE_LENGTH = 64;

interface PromoRow {
  code: string;
  comp_days: number;
  max_redemptions: number;
  redeemed_count: number;
  active: number;
}

/** D1 surfaces SQLite constraint violations as thrown Errors; the UNIQUE
 *  failure on promo_redemptions is the expected double-redeem signal. */
function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

/** Give a claimed slot back (the INSERT/grant lost — see the module note). */
async function releaseSlot(db: D1Database, code: string): Promise<void> {
  await db.prepare("UPDATE promo_codes SET redeemed_count = redeemed_count - 1 WHERE code = ?").bind(code).run();
}

/**
 * POST /console/promo — redeem a code for the signed-in user. Every outcome
 * is a 302 back to /console with an allowlisted feedback code; distinct
 * friendly copy for: invalid code / fully redeemed / already used a code /
 * already on a paid plan (console.ts).
 */
export async function handlePromoRedeemPost(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const user = await sessionUser(db, req, deps);
  if (!user) return redirectResponse("/login");
  const form = await req.formData();
  if (!verifyCsrfToken(req, form) || !isSameOriginRequest(req, resolveBoundOrigins(deps))) {
    return redirectResponse("/console?promo_err=session");
  }

  // Normalize case-insensitively: codes are stored UPPERCASE (migration 0016).
  const code = String(form.get("code") ?? "").trim().toUpperCase();
  if (code.length === 0 || code.length > MAX_CODE_LENGTH) {
    return redirectResponse("/console?promo_err=invalid");
  }

  // Only a trial/expired account can redeem — a paid tier has nothing to comp
  // onto. Refuse BEFORE claiming a slot so lookie-loos never burn the counter.
  // A trial user CAN redeem (a comp extends their runway); a CHURNED subscriber
  // (expired + a stale stripe id) CAN too — canStartCheckout is plan-only, so
  // #73's "stale id locks redemption" bug stays fixed.
  if (!canStartCheckout(user.plan)) {
    return redirectResponse("/console?promo_err=already-paid");
  }

  // Friendly fast path for the common repeat-submit; the PRIMARY KEY on the
  // INSERT below stays the authority under concurrency.
  const prior = await db
    .prepare("SELECT code FROM promo_redemptions WHERE user_id = ?")
    .bind(user.id)
    .first<{ code: string }>();
  if (prior) return redirectResponse("/console?promo_err=already-used");

  // Read the code row once — distinguishes invalid vs exhausted for honest
  // copy, and carries comp_days for the grant. The CAS below re-checks
  // everything atomically; this read never authorizes anything.
  const promo = await db
    .prepare("SELECT code, comp_days, max_redemptions, redeemed_count, active FROM promo_codes WHERE code = ?")
    .bind(code)
    .first<PromoRow>();
  if (!promo || promo.active !== 1) return redirectResponse("/console?promo_err=invalid");
  if (promo.redeemed_count >= promo.max_redemptions) return redirectResponse("/console?promo_err=exhausted");

  // 1. CLAIM THE SLOT — the atomic conditional increment (module note). Zero
  //    changes means the conditions flipped since the read: at launch pace
  //    that's the last slot going to a concurrent redeemer.
  const claim = await db
    .prepare(
      `UPDATE promo_codes SET redeemed_count = redeemed_count + 1
       WHERE code = ? AND active = 1 AND redeemed_count < max_redemptions`,
    )
    .bind(code)
    .run();
  if ((claim.meta.changes ?? 0) === 0) return redirectResponse("/console?promo_err=exhausted");

  const now = deps.now?.() ?? new Date();

  // 2. RECORD THE REDEMPTION — PRIMARY KEY(user_id) is the one-promo-per-
  //    account gate. A constraint loss (concurrent double-submit) gives the
  //    slot back and answers the same friendly copy as the fast path.
  //    `promo.code` (the validated ROW), not the request's `code`: byte-equal
  //    today only because the input was uppercased and the lookup collates
  //    BINARY. The ledger is the one place operator-facing growth reporting
  //    reads a stored string back out (/admin/growth's campaign card), so its
  //    provenance is made structural — it can only ever be a value that came
  //    from the promo_codes table — rather than incidentally sanitized.
  try {
    await db
      .prepare("INSERT INTO promo_redemptions (user_id, code, redeemed_at) VALUES (?, ?, ?)")
      .bind(user.id, promo.code, now.toISOString())
      .run();
  } catch (err) {
    await releaseSlot(db, code);
    if (isUniqueConstraintError(err)) return redirectResponse("/console?promo_err=already-used");
    throw err;
  }

  // 3. GRANT THE COMP — plan flips now; expiry is the EXISTING deferred-
  //    downgrade pair the hourly sweep applies (pending_plan='expired', the new
  //    floor). CAS on "still trial/expired": if a real checkout completed since
  //    our read it flipped the plan to a paid TIER, so this misses and we unwind
  //    entirely rather than schedule a downgrade for a paying customer (the
  //    strand/over-charge failure class). Trial and expired are BOTH redeemable
  //    (a trial redeeming just extends its runway onto the comp).
  const until = new Date(now.getTime() + promo.comp_days * 86_400_000).toISOString();
  const grant = await db
    .prepare(
      `UPDATE users SET plan = ?, pending_plan = 'expired', plan_downgrade_at = ?
       WHERE id = ? AND plan IN ('trial', 'expired')`,
    )
    .bind(PROMO_COMP_PLAN, until, user.id)
    .run();
  if ((grant.meta.changes ?? 0) === 0) {
    await db.prepare("DELETE FROM promo_redemptions WHERE user_id = ?").bind(user.id).run();
    await releaseSlot(db, code);
    console.warn(`event=promo_grant_lost_race user=${user.id} code=${code}`);
    return redirectResponse("/console?promo_err=already-paid");
  }

  // Caps lift immediately — the same best-effort push every plan-change seam
  // uses (a miss self-heals via the reconcilers / backfill script).
  const results = await applyPlanToVaults(db, deps, user.id);
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.warn(
      `event=promo_cap_push_partial user=${user.id} code=${code} failed=${failed.map((f) => f.vault).join(",")}`,
    );
  }
  console.log(`event=promo_redeemed user=${user.id} code=${code} until=${until} vaults=${results.length}`);
  return redirectResponse("/console?promo_redeemed=1");
}

/** One admin-overview row per code (read-only — admin.ts). */
export interface PromoCodeRow {
  code: string;
  compDays: number;
  maxRedemptions: number;
  redeemedCount: number;
  active: boolean;
}

/** All codes, for the /admin overview table (read-only visibility). */
export async function listPromoCodes(db: D1Database): Promise<PromoCodeRow[]> {
  const res = await db
    .prepare("SELECT code, comp_days, max_redemptions, redeemed_count, active FROM promo_codes ORDER BY code")
    .all<PromoRow>();
  return (res.results ?? []).map((r) => ({
    code: r.code,
    compDays: r.comp_days,
    maxRedemptions: r.max_redemptions,
    redeemedCount: r.redeemed_count,
    active: r.active === 1,
  }));
}
