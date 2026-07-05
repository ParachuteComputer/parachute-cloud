/**
 * The operator admin console (Wave 4c) — /admin, the fleet view + the two
 * moderation levers. Pure `(db, req, deps)` handlers like every other surface.
 *
 * TRUST BOUNDARY (every route, GET and POST): a live session cookie whose user
 * has role='operator'. Anything else — no session, expired session, a plain
 * user — gets the SAME 404 the router gives an unknown path, so the surface's
 * existence is never revealed (not a 403, not a login redirect; pinned by
 * tests + both smokes). POSTs additionally require CSRF + same-origin, exactly
 * the console's write boundary. Roles are NEVER writable here — only
 * scripts/set-operator-role.ts mints operators.
 *
 * SCOPE (deliberate): read + moderate. Usage numbers, never user content; no
 * impersonation; no delete. The levers:
 *   - set plan (free|parachute) — the comp lever; setUserPlan then
 *     applyPlanToVaults so storage caps push into the vault DOs immediately;
 *   - suspend / un-suspend — sessions die now (rows deleted + read-time
 *     refusal), login/magic answer neutrally without minting, OAuth tokens
 *     expire naturally, vault DATA untouched (migration 0011's contract).
 *
 * The old control plane's bearer-guarded fleet view (src/dashboard/index.ts)
 * was the ancestor; its queries were harvested, its v1 bearer auth replaced by
 * the real session + role model.
 */
import { ensureCsrfToken, verifyCsrfToken } from "./csrf.ts";
import { sessionUser } from "./session-user.ts";
import { deleteSessionsForUser } from "./sessions.ts";
import { getUserById, setUserPlan, setUserSuspended, type User } from "./users.ts";
import { coercePlanId, isCompPlan, isPlanId, planTotalBytes } from "./plans.ts";
import { applyPlanToVaults } from "./vault-call.ts";
import { collectDigestStats } from "./ops.ts";
import { latestUsageForVaults } from "./usage.ts";
import { listPromoCodes } from "./promo.ts";
import {
  type AdminUserRow,
  type AdminVaultRow,
  renderAdminOverview,
  renderAdminUsers,
  renderAdminVaults,
} from "./admin-ui.ts";
import {
  type OAuthDeps,
  htmlResponse,
  isSameOriginRequest,
  redirectResponse,
  resolveBoundOrigins,
} from "./oauth-shared.ts";

/** Rows per page in the users/vaults tables. */
export const ADMIN_PAGE_SIZE = 50;

/**
 * The one non-operator response: byte-identical to Hono's default 404 for an
 * unknown route, so probing /admin looks exactly like probing /nonsense.
 */
function notFound(): Response {
  return new Response("404 Not Found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=UTF-8" },
  });
}

/** Resolve the requesting operator, or null (→ the caller returns 404). */
async function operatorFor(db: D1Database, req: Request, deps: OAuthDeps): Promise<User | null> {
  const user = await sessionUser(db, req, deps);
  return user && user.role === "operator" ? user : null;
}

/** Page param: 1-based, clamped into [1, totalPages]. */
function pageParam(req: Request, totalPages: number): number {
  const raw = Number.parseInt(new URL(req.url).searchParams.get("page") ?? "1", 10);
  const page = Number.isFinite(raw) && raw >= 1 ? raw : 1;
  return Math.min(page, totalPages);
}

/**
 * Post-action notices ride the redirect as an allowlisted CODE (`?notice=` /
 * `?err=`) — the query string is user-editable, so it can only ever pick from
 * this fixed copy, never inject its own text.
 */
const NOTICES: Record<string, string> = {
  "plan-updated": "Plan updated — storage caps pushed to the user's vaults.",
  "plan-partial": "Plan updated, but one or more vault cap pushes failed — they self-heal via the daily reconcilers, or re-run scripts/backfill-plans.ts.",
  suspended: "Account suspended — sessions invalidated; sign-in now answers neutrally. Vault data untouched; tokens expire naturally.",
  unsuspended: "Account un-suspended — sign-in works again.",
};
const ERRORS: Record<string, string> = {
  csrf: "Your session expired. Please try again.",
  "not-found": "No such user.",
  invalid: "Invalid request.",
  "self-suspend": "You can't suspend your own account (that would lock out this console).",
};

// --- GET /admin — the fleet overview ----------------------------------------

export async function handleAdminOverviewGet(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const operator = await operatorFor(db, req, deps);
  if (!operator) return notFound();
  const now = deps.now?.() ?? new Date();

  // Totals + 7d deltas + magic sent/failed: the exact weekly-digest queries
  // (ops.ts) — one source for "how many", whether it lands in email or here.
  const stats = await collectDigestStats(db, now);

  // Last 7 UTC days, today first, zero-filled — the sparkline-ish table wants
  // a row per day even when nothing happened.
  const days: string[] = [];
  for (let i = 0; i < 7; i++) days.push(new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10));
  const sinceDay = days[6]!;
  const signupRes = await db
    .prepare("SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n FROM users WHERE created_at >= ? GROUP BY day")
    .bind(sinceDay)
    .all<{ day: string; n: number }>();
  const byDay = new Map((signupRes.results ?? []).map((r) => [r.day, r.n]));
  const signupsByDay = days.map((day) => ({ day, count: byDay.get(day) ?? 0 }));

  // Drip counters over the window, summed per event (PII-free by design).
  const dripRes = await db
    .prepare("SELECT event, SUM(count) AS n FROM drip_events WHERE day >= ? GROUP BY event ORDER BY event")
    .bind(sinceDay)
    .all<{ event: string; n: number }>();
  const dripEvents7d = (dripRes.results ?? []).map((r) => ({ event: r.event, count: r.n }));

  // Latest ops alerts — the health check's dedupe rows double as the log.
  const alertRes = await db
    .prepare("SELECT key, last_alert_at FROM ops_alerts ORDER BY last_alert_at DESC LIMIT 10")
    .all<{ key: string; last_alert_at: string }>();
  const latestAlerts = (alertRes.results ?? []).map((r) => ({ key: r.key, lastAlertAt: r.last_alert_at }));

  // Promo codes (July 4th launch) — read-only redemption visibility; the rows
  // themselves are tuned via D1 statements (migration 0016's header).
  const promoCodes = await listPromoCodes(db);

  return htmlResponse(renderAdminOverview({ stats, dripEvents7d, signupsByDay, latestAlerts, promoCodes }));
}

// --- GET /admin/users --------------------------------------------------------

interface UserPageRow {
  id: string;
  email: string;
  plan: string;
  role: string;
  created_at: string;
  suspended_at: string | null;
  drip_unsubscribed: string | null;
  payment_failed_at: string | null;
  payment_failed_count: number;
  pending_plan: string | null;
  vault_count: number;
  checklist_done: number;
}

export async function handleAdminUsersGet(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const operator = await operatorFor(db, req, deps);
  if (!operator) return notFound();

  const totalRow = await db.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
  const totalUsers = totalRow?.n ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalUsers / ADMIN_PAGE_SIZE));
  const page = pageParam(req, totalPages);

  // One page of accounts, newest first, with the per-user aggregates the table
  // shows (vault count, checklist progress excluding the reserved `hidden`
  // dismissal row). Correlated subqueries keep it one round-trip; fine at
  // page-size 50.
  const res = await db
    .prepare(
      `SELECT u.id, u.email, u.plan, u.role, u.created_at, u.suspended_at, u.drip_unsubscribed,
         u.payment_failed_at, u.payment_failed_count, u.pending_plan,
         (SELECT COUNT(*) FROM vaults v WHERE v.owner_user_id = u.id) AS vault_count,
         (SELECT COUNT(*) FROM user_checklist c WHERE c.user_id = u.id AND c.item <> 'hidden') AS checklist_done
       FROM users u
       ORDER BY u.created_at DESC, u.id DESC
       LIMIT ? OFFSET ?`,
    )
    .bind(ADMIN_PAGE_SIZE, (page - 1) * ADMIN_PAGE_SIZE)
    .all<UserPageRow>();

  const users: AdminUserRow[] = (res.results ?? []).map((r) => ({
    id: r.id,
    email: r.email,
    plan: coercePlanId(r.plan),
    role: r.role,
    createdAt: r.created_at,
    suspendedAt: r.suspended_at,
    dripUnsubscribed: r.drip_unsubscribed !== null,
    // Soft dunning (Wave 4d): flagged by invoice.payment_failed, cleared by
    // invoice.paid — surfaced as a badge; action stays operator-judgment.
    paymentFailedAt: r.payment_failed_at,
    paymentFailedCount: r.payment_failed_count,
    // A scheduled downgrade (cancel_at_period_end / subscription deleted).
    pendingPlan: r.pending_plan,
    vaultCount: r.vault_count,
    checklistDone: r.checklist_done,
  }));

  const params = new URL(req.url).searchParams;
  const csrf = ensureCsrfToken(req);
  return htmlResponse(
    renderAdminUsers({
      users,
      page,
      totalPages,
      totalUsers,
      csrfToken: csrf.token,
      notice: NOTICES[params.get("notice") ?? ""],
      error: ERRORS[params.get("err") ?? ""],
    }),
    200,
    csrf.setCookie ? { "set-cookie": csrf.setCookie } : {},
  );
}

// --- GET /admin/vaults -------------------------------------------------------

interface VaultPageRow {
  name: string;
  created_at: string;
  owner_email: string | null;
  owner_plan: string | null;
}

export async function handleAdminVaultsGet(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const operator = await operatorFor(db, req, deps);
  if (!operator) return notFound();

  const totalRow = await db.prepare("SELECT COUNT(*) AS n FROM vaults").first<{ n: number }>();
  const totalVaults = totalRow?.n ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalVaults / ADMIN_PAGE_SIZE));
  const page = pageParam(req, totalPages);

  const res = await db
    .prepare(
      `SELECT v.name, v.created_at, u.email AS owner_email, u.plan AS owner_plan
       FROM vaults v LEFT JOIN users u ON u.id = v.owner_user_id
       ORDER BY v.created_at DESC, v.name ASC
       LIMIT ? OFFSET ?`,
    )
    .bind(ADMIN_PAGE_SIZE, (page - 1) * ADMIN_PAGE_SIZE)
    .all<VaultPageRow>();
  const rows = res.results ?? [];

  // Latest rollup row per vault on THIS page (usage.ts — the console's own
  // read, reused). Vaults without a row render "no rollup row yet".
  const usage = await latestUsageForVaults(db, rows.map((r) => r.name));

  const vaults: AdminVaultRow[] = rows.map((r) => {
    const u = usage.get(r.name);
    return {
      name: r.name,
      ownerEmail: r.owner_email,
      createdAt: r.created_at,
      usage: u ? { dbBytes: u.dbBytes, r2Bytes: u.r2Bytes, day: u.day, transcribeMinutes: u.transcribeMinutes } : null,
      // Per-vault cap = the owner's plan two-meter budgets summed (plans.ts).
      // An orphan owner coerces to the expired floor — the conservative read.
      capBytes: planTotalBytes(coercePlanId(r.owner_plan)),
    };
  });

  return htmlResponse(renderAdminVaults({ vaults, page, totalPages, totalVaults }));
}

// --- POST actions ------------------------------------------------------------

/** Shared POST prologue: operator + CSRF + same-origin, and the target user. */
async function actionContext(
  db: D1Database,
  req: Request,
  deps: OAuthDeps,
): Promise<{ operator: User; form: FormData; back: (q: string) => Response } | Response> {
  const operator = await operatorFor(db, req, deps);
  if (!operator) return notFound();
  const form = await req.formData();
  // Round-trip the table page so an action on page 3 lands back on page 3.
  const rawPage = Number.parseInt(String(form.get("page") ?? "1"), 10);
  const pageQ = Number.isFinite(rawPage) && rawPage > 1 ? `&page=${rawPage}` : "";
  const back = (q: string) => redirectResponse(`/admin/users?${q}${pageQ}`);
  if (!verifyCsrfToken(req, form) || !isSameOriginRequest(req, resolveBoundOrigins(deps))) {
    return back("err=csrf");
  }
  return { operator, form, back };
}

/**
 * POST /admin/users/plan — the comp lever: set a user's plan, then push the
 * new caps into every vault they own (applyPlanToVaults — the exact seam a
 * Stripe webhook will call). IDOR-safe: the target must be an existing user
 * row; the plan value must be a known PlanId.
 */
export async function handleAdminSetPlanPost(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const ctx = await actionContext(db, req, deps);
  if (ctx instanceof Response) return ctx;
  const { form, back } = ctx;

  const plan = String(form.get("plan") ?? "");
  // Comp-able plans only: paid tiers + `expired`. `trial` is refused — the
  // clock-clear below would make a comped trial eternal + clockless (it would
  // never convert and never expire). Comp to `plus` for the trial experience.
  if (!isPlanId(plan) || !isCompPlan(plan)) return back("err=invalid");
  const target = await getUserById(db, String(form.get("user_id") ?? ""));
  if (!target) return back("err=not-found");

  await setUserPlan(db, target.id, plan);
  // An operator's explicit plan set is authoritative: clear any pending
  // downgrade / trial clock so the hourly sweep doesn't revert the comp (the
  // subscription.updated "plan applied" semantics). A comp is indefinite until
  // the operator changes it again.
  await db.prepare("UPDATE users SET pending_plan = NULL, plan_downgrade_at = NULL WHERE id = ?").bind(target.id).run();
  // Push the new entitlement into the vault DOs NOW — a comp must take effect
  // while the person is looking. Best-effort per vault (vault-call.ts); a miss
  // is reported and reconciled by the backfill script / next plan change.
  const results = await applyPlanToVaults(db, deps, target.id);
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.warn(`event=admin_plan_cap_partial user=${target.id} plan=${plan} failed=${failed.map((f) => f.vault).join(",")}`);
    return back("notice=plan-partial");
  }
  console.log(`event=admin_plan_set user=${target.id} plan=${plan} vaults=${results.length}`);
  return back("notice=plan-updated");
}

/**
 * POST /admin/users/suspend — toggle suspension (`act` = suspend|unsuspend).
 * Suspend: timestamp the row + delete the user's sessions (immediate), with
 * findActiveSession's read-time refusal as the backstop; login/magic answer
 * neutrally from here on. Un-suspend: clear the timestamp — sign-in works
 * again (nothing else was touched). Self-suspend is refused: the last
 * operator locking themselves out helps no one.
 */
export async function handleAdminSuspendPost(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const ctx = await actionContext(db, req, deps);
  if (ctx instanceof Response) return ctx;
  const { operator, form, back } = ctx;

  const act = String(form.get("act") ?? "");
  if (act !== "suspend" && act !== "unsuspend") return back("err=invalid");
  const target = await getUserById(db, String(form.get("user_id") ?? ""));
  if (!target) return back("err=not-found");

  if (act === "suspend") {
    if (target.id === operator.id) return back("err=self-suspend");
    await setUserSuspended(db, target.id, deps.now?.() ?? new Date());
    await deleteSessionsForUser(db, target.id);
    console.log(`event=admin_user_suspended user=${target.id} by=${operator.id}`);
    return back("notice=suspended");
  }
  await setUserSuspended(db, target.id, null);
  console.log(`event=admin_user_unsuspended user=${target.id} by=${operator.id}`);
  return back("notice=unsuspended");
}
