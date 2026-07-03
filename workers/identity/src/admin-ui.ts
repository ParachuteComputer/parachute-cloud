/**
 * Operator admin console views (Wave 4c) — server-rendered HTML in the exact
 * ui.ts style (same page shell + brand styles; a small extra style block widens
 * the layout for tables). Views only: every query + gate lives in admin.ts.
 *
 * The surface is READ + MODERATE by design: usage numbers, never user content;
 * the two levers are set-plan (the comp lever) and suspend/un-suspend. No
 * impersonation, no vault access, no delete, no role-granting.
 */
import { esc, page } from "./ui.ts";
import { CHECKLIST_ITEMS } from "./checklist.ts";
import { PLAN_SPECS, type PlanId, formatPlanBytes, formatUsageBytes } from "./plans.ts";
import type { DigestStats } from "./ops.ts";

/** Widen the ui.ts shell (30rem is right for forms, not fleet tables). */
const ADMIN_STYLE = `<style>
  body{max-width:64rem}
  table.fleet{width:100%;border-collapse:collapse;font-size:.88rem;margin-top:.4rem}
  table.fleet th{text-align:left;font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);padding:.45rem .5rem;border-bottom:1px solid var(--line)}
  table.fleet td{padding:.5rem;border-bottom:1px solid var(--line);vertical-align:top}
  table.fleet tr:last-child td{border-bottom:0}
  .tablewrap{overflow-x:auto}
  .statgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(10rem,1fr));gap:.9rem}
  .stat{border:1px solid var(--line);border-radius:11px;padding:.8rem 1rem;background:#fcfdfb}
  .stat .k{font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
  .stat .v{font-size:1.5rem;font-family:"Instrument Serif",Georgia,serif}
  .stat .sub{font-size:.8rem;color:var(--muted)}
  .adminnav{display:flex;gap:1rem;align-items:baseline;margin:.15rem 0 1.2rem;font-size:.92rem}
  .badge{display:inline-block;font-size:.72rem;font-weight:600;padding:.1rem .5rem;border-radius:999px;background:#eef0ea;color:var(--muted)}
  .badge-warn{background:#faeee9;color:#8a3a2a}
  .badge-on{background:#eaf2e6;color:var(--sage-dark)}
  .rowbtn{font-size:.8rem;padding:.3rem .6rem;background:#eef0ea;color:var(--ink);border-radius:7px}
  .rowbtn:hover{background:#e4e8dd}
  .bars td{padding:.28rem .5rem}
  .bar{display:inline-block;height:.65rem;background:var(--sage);border-radius:3px;vertical-align:middle}
</style>`;

/** Shared header: title, section nav, way back to the console. */
function adminHeader(title: string, active: "overview" | "users" | "vaults"): string {
  const link = (href: string, label: string, key: string) =>
    active === key ? `<strong>${esc(label)}</strong>` : `<a href="${esc(href)}">${esc(label)}</a>`;
  return `<div class="h2row"><h1 style="margin:0">${esc(title)}</h1><a href="/console">&larr; Console</a></div>
    <div class="adminnav">
      ${link("/admin", "Overview", "overview")}
      ${link("/admin/users", "Users", "users")}
      ${link("/admin/vaults", "Vaults", "vaults")}
    </div>`;
}

function banner(notice?: string, error?: string): string {
  return `${notice ? `<div class="notice">${esc(notice)}</div>` : ""}${error ? `<div class="err" style="margin-bottom:1rem">${esc(error)}</div>` : ""}`;
}

// --- overview ---------------------------------------------------------------

export interface AdminOverviewProps {
  /** users/vaults totals + 7d deltas + magic sent/failed 7d (ops.ts collectDigestStats). */
  stats: DigestStats;
  /** Drip counter rows over 7d, summed per event ("<kind>:sent" | "<kind>:failed" | "unsubscribed"). */
  dripEvents7d: Array<{ event: string; count: number }>;
  /** Signups per UTC day, newest first, zero-filled to exactly 7 rows. */
  signupsByDay: Array<{ day: string; count: number }>;
  /** Latest ops alert rows (ops_alerts), newest first. */
  latestAlerts: Array<{ key: string; lastAlertAt: string }>;
}

export function renderAdminOverview(props: AdminOverviewProps): string {
  const { stats, dripEvents7d, signupsByDay, latestAlerts } = props;
  const stat = (k: string, v: number | string, sub = "") =>
    `<div class="stat"><div class="k">${esc(k)}</div><div class="v">${esc(String(v))}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ""}</div>`;

  // Sparkline-ish signups table: a proportional bar per day, newest first.
  const maxSignups = Math.max(1, ...signupsByDay.map((r) => r.count));
  const signupRows = signupsByDay
    .map(
      (r) =>
        `<tr data-testid="admin-signup-day"><td>${esc(r.day)}</td><td style="width:4rem;text-align:right">${r.count}</td>
         <td style="width:60%"><span class="bar" style="width:${Math.round((r.count / maxSignups) * 100)}%"></span></td></tr>`,
    )
    .join("\n");

  const dripRows =
    dripEvents7d.length === 0
      ? `<tr><td colspan="2" class="muted">No drip events in the last 7 days.</td></tr>`
      : dripEvents7d
          .map((r) => `<tr><td><code>${esc(r.event)}</code></td><td style="text-align:right">${r.count}</td></tr>`)
          .join("\n");

  const alertRows =
    latestAlerts.length === 0
      ? `<tr><td colspan="2" class="muted">No ops alerts recorded — quiet skies.</td></tr>`
      : latestAlerts
          .map((r) => `<tr><td><code>${esc(r.key)}</code></td><td>${esc(r.lastAlertAt)}</td></tr>`)
          .join("\n");

  return page(
    "Admin — Parachute",
    `${ADMIN_STYLE}
     ${adminHeader("Fleet overview", "overview")}
     <div class="statgrid">
       ${stat("Users", stats.usersTotal, `+${stats.usersNew7d} in 7d`)}
       ${stat("Vaults", stats.vaultsTotal, `+${stats.vaultsNew7d} in 7d`)}
       ${stat("Magic links 7d", stats.magicSent7d, `${stats.magicFailed7d} failed`)}
     </div>
     <div class="card" style="margin-top:1.1rem">
       <h2>Signups — last 7 days</h2>
       <div class="tablewrap"><table class="fleet bars"><tbody>${signupRows}</tbody></table></div>
     </div>
     <div class="card">
       <h2>Drip sends — last 7 days</h2>
       <div class="tablewrap"><table class="fleet"><thead><tr><th>Event</th><th style="text-align:right">Count</th></tr></thead><tbody>${dripRows}</tbody></table></div>
     </div>
     <div class="card">
       <h2>Latest ops alerts</h2>
       <p class="muted" style="margin:.1rem 0 .3rem">Health-check alert dedupe keys + when each last emailed (ops_alerts).</p>
       <div class="tablewrap"><table class="fleet"><thead><tr><th>Alert key</th><th>Last alerted</th></tr></thead><tbody>${alertRows}</tbody></table></div>
     </div>`,
  );
}

// --- users ------------------------------------------------------------------

export interface AdminUserRow {
  id: string;
  email: string;
  plan: PlanId;
  role: string;
  createdAt: string;
  suspendedAt: string | null;
  dripUnsubscribed: boolean;
  vaultCount: number;
  checklistDone: number;
}

export interface AdminUsersProps {
  users: AdminUserRow[];
  page: number;
  totalPages: number;
  totalUsers: number;
  csrfToken: string;
  notice?: string;
  error?: string;
}

/** Prev/Next pager, preserving the section path. */
function pager(path: string, current: number, totalPages: number): string {
  const prev = current > 1 ? `<a href="${esc(path)}?page=${current - 1}">&larr; Newer</a>` : `<span class="muted">&larr; Newer</span>`;
  const next = current < totalPages ? `<a href="${esc(path)}?page=${current + 1}">Older &rarr;</a>` : `<span class="muted">Older &rarr;</span>`;
  return `<div style="display:flex;justify-content:space-between;margin-top:.8rem;font-size:.9rem">${prev}<span class="muted" data-testid="admin-page">Page ${current} of ${totalPages}</span>${next}</div>`;
}

export function renderAdminUsers(props: AdminUsersProps): string {
  const { users, page: current, totalPages, totalUsers, csrfToken, notice, error } = props;
  const rows = users
    .map((u) => {
      const otherPlan: PlanId = u.plan === "parachute" ? "free" : "parachute";
      const planForm = `<form class="inline" method="post" action="/admin/users/plan">
          <input type="hidden" name="__csrf" value="${esc(csrfToken)}">
          <input type="hidden" name="user_id" value="${esc(u.id)}">
          <input type="hidden" name="plan" value="${esc(otherPlan)}">
          <input type="hidden" name="page" value="${current}">
          <button class="rowbtn" type="submit">&rarr; ${esc(PLAN_SPECS[otherPlan].label)}</button>
        </form>`;
      const suspendForm = `<form class="inline" method="post" action="/admin/users/suspend">
          <input type="hidden" name="__csrf" value="${esc(csrfToken)}">
          <input type="hidden" name="user_id" value="${esc(u.id)}">
          <input type="hidden" name="act" value="${u.suspendedAt ? "unsuspend" : "suspend"}">
          <input type="hidden" name="page" value="${current}">
          <button class="rowbtn" type="submit">${u.suspendedAt ? "Un-suspend" : "Suspend"}</button>
        </form>`;
      const flags = [
        u.role === "operator" ? `<span class="badge badge-on">operator</span>` : "",
        u.suspendedAt ? `<span class="badge badge-warn">suspended ${esc(u.suspendedAt.slice(0, 10))}</span>` : "",
        u.dripUnsubscribed ? `<span class="badge">drip-unsub</span>` : "",
      ]
        .filter(Boolean)
        .join(" ");
      return `<tr data-testid="admin-user-row">
        <td>${esc(u.email)}${flags ? `<br>${flags}` : ""}</td>
        <td>${esc(PLAN_SPECS[u.plan].label)}</td>
        <td>${esc(u.createdAt.slice(0, 10))}</td>
        <td style="text-align:right">${u.vaultCount}</td>
        <td style="text-align:right">${u.checklistDone}/${CHECKLIST_ITEMS.length}</td>
        <td>${planForm} ${suspendForm}</td>
      </tr>`;
    })
    .join("\n");
  return page(
    "Admin · Users — Parachute",
    `${ADMIN_STYLE}
     ${adminHeader("Users", "users")}
     ${banner(notice, error)}
     <div class="card">
       <p class="muted" style="margin:.1rem 0 .3rem">${totalUsers} account${totalUsers === 1 ? "" : "s"}, newest first. Plan is the comp lever (caps push to the vaults immediately); suspend blocks sign-in without touching vault data.</p>
       <div class="tablewrap"><table class="fleet">
         <thead><tr><th>Email</th><th>Plan</th><th>Created</th><th style="text-align:right">Vaults</th><th style="text-align:right">Checklist</th><th>Actions</th></tr></thead>
         <tbody>${rows || `<tr><td colspan="6" class="muted">No users on this page.</td></tr>`}</tbody>
       </table></div>
       ${pager("/admin/users", current, totalPages)}
     </div>`,
  );
}

// --- vaults -----------------------------------------------------------------

export interface AdminVaultRow {
  name: string;
  ownerEmail: string | null;
  createdAt: string;
  /** Latest vault_usage split, or null when no rollup row exists yet. */
  usage: { dbBytes: number; r2Bytes: number; day: string } | null;
  /** The owner's plan cap (v1: per-vault cap = plan total). */
  capBytes: number;
}

export interface AdminVaultsProps {
  vaults: AdminVaultRow[];
  page: number;
  totalPages: number;
  totalVaults: number;
}

export function renderAdminVaults(props: AdminVaultsProps): string {
  const { vaults, page: current, totalPages, totalVaults } = props;
  const rows = vaults
    .map((v) => {
      const usage = v.usage
        ? `${formatUsageBytes(v.usage.dbBytes + v.usage.r2Bytes)} <span class="muted">(db ${formatUsageBytes(v.usage.dbBytes)} + r2 ${formatUsageBytes(v.usage.r2Bytes)}, ${esc(v.usage.day)})</span>`
        : `<span class="muted">no rollup row yet</span>`;
      return `<tr data-testid="admin-vault-row">
        <td><code>${esc(v.name)}</code></td>
        <td>${v.ownerEmail ? esc(v.ownerEmail) : `<span class="badge badge-warn">orphan</span>`}</td>
        <td>${esc(v.createdAt.slice(0, 10))}</td>
        <td>${usage}</td>
        <td>${esc(formatPlanBytes(v.capBytes))}</td>
      </tr>`;
    })
    .join("\n");
  return page(
    "Admin · Vaults — Parachute",
    `${ADMIN_STYLE}
     ${adminHeader("Vaults", "vaults")}
     <div class="card">
       <p class="muted" style="margin:.1rem 0 .3rem">${totalVaults} vault${totalVaults === 1 ? "" : "s"}, newest first. Usage is the latest daily rollup row (vault_usage); cap is the owner's plan (v1: per-vault cap = plan total).</p>
       <div class="tablewrap"><table class="fleet">
         <thead><tr><th>Name</th><th>Owner</th><th>Created</th><th>Latest usage</th><th>Cap</th></tr></thead>
         <tbody>${rows || `<tr><td colspan="5" class="muted">No vaults on this page.</td></tr>`}</tbody>
       </table></div>
       ${pager("/admin/vaults", current, totalPages)}
     </div>`,
  );
}
