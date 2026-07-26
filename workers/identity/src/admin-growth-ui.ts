/**
 * The Growth panel's view (/admin/growth) — server-rendered HTML in the exact
 * admin-ui.ts chrome (same `page` shell, same ADMIN_STYLE, same statgrid/fleet/
 * bar classes, same console CSS variables). Views only: every query lives in
 * admin-growth.ts.
 *
 * NO JAVASCRIPT. The sparkline is an inline SVG `<polyline>` and the funnel is
 * CSS-width bars, so the page renders identically under the console's strict
 * CSP (`default-src 'none'`) and needs no nonce, no chart library, no fetch.
 *
 * Every proxy metric renders next to a "how measured" line naming its blind
 * spot. That is a product decision, not decoration: this page exists to inform
 * growth judgement, and a proxy presented as a fact is worse than no number.
 */
import { esc, page } from "./ui.ts";
import { ADMIN_STYLE, adminHeader } from "./admin-ui.ts";
// Durations in the copy are INTERPOLATED from their defining constants, never
// spelled as literals. The trial length is in flight (30 → 90) and the session
// / refresh TTLs are equally free to move; a page whose whole premise is honest
// measurement must not be the thing that goes stale.
import { PLAN_SPECS, TRIAL_DURATION_DAYS } from "./plans.ts";
import { SESSION_TTL_MS } from "./sessions.ts";
import { REFRESH_TOKEN_TTL_MS } from "./tokens.ts";

const MS_PER_DAY = 86_400_000;
const SESSION_TTL_DAYS = Math.round(SESSION_TTL_MS / MS_PER_DAY);
const REFRESH_TTL_DAYS = Math.round(REFRESH_TOKEN_TTL_MS / MS_PER_DAY);
import {
  ARRIVAL_WEEKS,
  CONTENT_GROWTH_BYTES,
  TRIAL_HORIZON_DAYS,
  type FunnelCohort,
  type FunnelStageKey,
  type GrowthProps,
} from "./admin-growth.ts";

/**
 * The privacy contract, rendered verbatim at the foot of the page. A static
 * constant with NO interpolation — it is written into the document unescaped on
 * purpose, so the sentence appears in the page source byte-for-byte (an escaped
 * apostrophe would make the promise unquotable). It contains no HTML
 * metacharacters; `admin-growth.test.ts` pins both the text and its presence.
 */
export const GROWTH_PRIVACY_FOOTER =
  "What this page never shows: note content, titles, or queries; any individual person's behavior or timeline; email addresses; IP addresses. Everything here is counts, cohorts, and buckets over data Parachute already keeps to run the service. Individual accounts appear only in Users/Vaults — the operations tables — for comp and suspend.";

/** Growth-only chrome: the sparkline frame + the funnel bar tracks. */
const GROWTH_STYLE = `<style>
  .spark{display:block;width:100%;height:3.2rem;margin:.5rem 0 .2rem}
  .sparkaxis{display:flex;justify-content:space-between;font-size:.72rem;color:var(--muted)}
  .cohorts{display:grid;grid-template-columns:repeat(auto-fit,minmax(17rem,1fr));gap:1.3rem;margin-top:.6rem}
  .cohort h3{margin:0 0 .1rem;font-family:var(--font-round);font-size:.92rem;font-weight:600}
  .stage{margin:.55rem 0}
  .stagehead{display:flex;justify-content:space-between;align-items:baseline;gap:.6rem;font-size:.86rem}
  .stagenum{font-family:var(--font-round);font-weight:600;white-space:nowrap}
  .track{display:block;height:.65rem;background:var(--fill);border-radius:3px;margin-top:.22rem}
  .stage-muted .stagehead,.stage-muted .stagenum{color:var(--muted)}
  .stage-muted .track{background:var(--fill-2)}
  .how{font-size:.78rem;color:var(--muted);margin:.35rem 0 0;line-height:1.45}
  .privacy{background:var(--fill-2);border:1px solid var(--line);border-radius:var(--radius-panel);padding:.9rem 1.05rem;font-size:.84rem;color:var(--muted);line-height:1.5}
</style>`;

// --- small pieces ---------------------------------------------------------------

function pct(n: number, total: number): number {
  return total > 0 ? Math.round((n / total) * 100) : 0;
}

function stat(k: string, v: number | string, sub = ""): string {
  return `<div class="stat"><div class="k">${esc(k)}</div><div class="v">${esc(String(v))}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ""}</div>`;
}

/**
 * A pure-SVG sparkline: one `<polyline>` through the weekly counts, scaled to
 * the tallest week. `vector-effect="non-scaling-stroke"` keeps the line an even
 * weight after the viewBox is stretched to the card width. The aria-label
 * carries the actual numbers, so the series is readable without sight and
 * greppable in the page source.
 */
function sparkline(values: number[], label: string): string {
  const w = 300;
  const h = 48;
  const pad = 4;
  const max = Math.max(1, ...values);
  const n = values.length;
  const x = (i: number) => (n <= 1 ? w / 2 : pad + (i * (w - 2 * pad)) / (n - 1));
  const y = (v: number) => h - pad - (v / max) * (h - 2 * pad);
  const points = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  return `<svg class="spark" data-testid="growth-sparkline" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="${esc(label)}">
      <line x1="0" y1="${h - pad}" x2="${w}" y2="${h - pad}" stroke="var(--line)" stroke-width="1" vector-effect="non-scaling-stroke"/>
      <polyline points="${points}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
    </svg>`;
}

/** One funnel stage: label, count, share of the cohort, and a proportional bar. */
function stageRow(label: string, n: number, total: number, tooYoung: boolean): string {
  if (tooYoung) {
    return `<div class="stage stage-muted" data-testid="growth-stage">
        <div class="stagehead"><span>${esc(label)}</span><span class="stagenum">too young</span></div>
        <div class="track"></div>
      </div>`;
  }
  const share = pct(n, total);
  return `<div class="stage" data-testid="growth-stage">
      <div class="stagehead"><span>${esc(label)}</span><span class="stagenum">${n} <span class="muted">&middot; ${share}%</span></span></div>
      <div class="track"><span class="bar" style="width:${share}%"></span></div>
    </div>`;
}

const STAGE_LABELS: Array<{ key: FunnelStageKey; label: string }> = [
  { key: "signedUp", label: "Signed up" },
  { key: "createdVault", label: "Created a vault" },
  { key: "hasContent", label: "Has content" },
  { key: "connectedAi", label: "Connected an AI" },
  { key: "returnedWeek2", label: "Came back in week 2" },
];

function cohortColumn(c: FunnelCohort): string {
  const total = c.counts.signedUp;
  const stages = STAGE_LABELS.map(({ key, label }) =>
    stageRow(label, c.counts[key], total, key === "returnedWeek2" && c.week2TooYoung),
  ).join("\n");
  return `<div class="cohort" data-testid="growth-cohort">
      <h3>${esc(c.label)}</h3>
      <div class="muted">${total} account${total === 1 ? "" : "s"} in this cohort</div>
      ${stages}
    </div>`;
}

// --- the page -------------------------------------------------------------------

export function renderAdminGrowth(props: GrowthProps): string {
  const { arrival, cohorts, planMix, totalUsers, trials, promoDays, promoTotals } = props;

  // --- arrival
  const delta = arrival.signups7d - arrival.signupsPrev7d;
  const deltaLabel = `${delta > 0 ? "+" : delta < 0 ? "−" : "±"}${Math.abs(delta)}`;
  const weekCounts = arrival.weeks.map((w) => w.count);
  const sparkLabel = `Signups per week, ${ARRIVAL_WEEKS} weeks, oldest to newest: ${weekCounts.join(", ")}`;

  // --- plan mix
  const planRows =
    planMix.length === 0
      ? `<tr><td colspan="3" class="muted">No accounts yet.</td></tr>`
      : planMix
          .map(
            (p) => `<tr data-testid="growth-plan-row">
        <td>${esc(PLAN_SPECS[p.plan].label)}</td>
        <td style="text-align:right">${p.count}</td>
        <td style="width:55%"><span class="bar" style="width:${pct(p.count, totalUsers)}%"></span> <span class="muted">${pct(p.count, totalUsers)}%</span></td>
      </tr>`,
          )
          .join("\n");

  // --- campaign
  const promoTotalLine =
    promoTotals.length === 0
      ? `<span class="muted">No promo codes have been redeemed yet.</span>`
      : promoTotals.map((t) => `<code>${esc(t.code)}</code> ${t.count}`).join(" &middot; ");
  const maxPromoDay = Math.max(1, ...promoDays.map((d) => d.count));
  const promoRows =
    promoDays.length === 0
      ? `<tr><td colspan="3" class="muted">No redemptions recorded.</td></tr>`
      : promoDays
          .map(
            (d) => `<tr data-testid="growth-promo-row">
        <td>${esc(d.day)}</td>
        <td><code>${esc(d.code)}</code></td>
        <td style="width:55%">${d.count} <span class="bar" style="width:${Math.round((d.count / maxPromoDay) * 60)}%"></span></td>
      </tr>`,
          )
          .join("\n");

  return page(
    "Admin · Growth — Parachute",
    `${ADMIN_STYLE}${GROWTH_STYLE}
     ${adminHeader("Growth", "growth")}

     <div class="card" data-testid="growth-arrival">
       <h2>Arrival</h2>
       <div class="statgrid">
         ${stat("Signups 7d", arrival.signups7d, `${arrival.signupsPrev7d} the 7 days before`)}
         ${stat("Signups 30d", arrival.signups30d)}
         ${stat("Week over week", deltaLabel, "vs the previous 7 days")}
       </div>
       ${sparkline(weekCounts, sparkLabel)}
       <div class="sparkaxis"><span>${esc(arrival.weeks[0]?.weekStart ?? "")}</span><span>${ARRIVAL_WEEKS} weeks of signups</span><span>${esc(arrival.weeks[arrival.weeks.length - 1]?.weekStart ?? "")}</span></div>
       <p class="how">How measured: <code>users.created_at</code>, bucketed by UTC day and summed into weeks. Exact.</p>
       <p class="how">No acquisition-source data is captured anywhere in this system &mdash; not a referrer, not a UTM tag, not a "how did you hear about us" field. This page can tell you WHEN someone arrived and never WHERE FROM. If that question matters for the launch, it needs a deliberate collection decision first.</p>
     </div>

     <div class="card">
       <h2>Activation funnel</h2>
       <p class="muted" style="margin:.1rem 0 .3rem">Two cohorts, so a week-2 number is only ever read off accounts old enough to have one. Stages are measured INDEPENDENTLY, not nested &mdash; someone can connect an AI before writing anything, so a later bar may exceed an earlier one.</p>
       <div class="cohorts">${cohorts.map(cohortColumn).join("\n")}</div>
       <p class="how"><strong>Created a vault</strong> &mdash; exact: a <code>vaults</code> row owned by the account.</p>
       <p class="how"><strong>Has content</strong> &mdash; proxy, and it errs in BOTH directions: the getting-started checklist recorded <code>write-note</code> or <code>import-notes</code>, OR an owned vault's storage grew more than ${Math.round(CONTENT_GROWTH_BYTES / 1024)} KiB between its earliest and latest daily rollup. It OVER-counts, because a checklist row records a CLICK on the checklist door rather than a saved note &mdash; the console marks the item and sends you to the editor in one gesture, so someone who opened the editor and typed nothing still counts here. It UNDER-counts, because growth is latest-minus-earliest and the earliest rollup IS the baseline: a vault's entire first rollup is invisible permanently &mdash; a day-0 import that lands before the first rollup ever runs shows zero growth forever, not just until tomorrow. Anything written and deleted between two rollups is invisible too.</p>
       <p class="how"><strong>Connected an AI</strong> &mdash; exact for OAuth: an issued token or a standing grant for any client that isn't the console itself. This is the precise inverse of the day-3 connect-nudge query, so the nudge and this bar can never disagree.</p>
       <p class="how"><strong>Came back in week 2</strong> &mdash; proxy, and an UNDER-count: a new session row, a new token row, or rolled-up vault bytes that changed, dated inside that account's own days 7&ndash;14. Session cookies last ${SESSION_TTL_DAYS} days and slide on use, so someone who returns on an existing cookie leaves no new row; an MCP client reading inside its ${REFRESH_TTL_DAYS}-day refresh cycle leaves none either. Read a low number as "at least this many", never as "only this many".</p>
     </div>

     <div class="card">
       <h2>Plan mix</h2>
       <div class="tablewrap"><table class="fleet bars">
         <thead><tr><th>Plan</th><th style="text-align:right">Accounts</th><th>Share of ${totalUsers}</th></tr></thead>
         <tbody>${planRows}</tbody>
       </table></div>
       <p class="how">How measured: <code>users.plan</code> as stored, with unknown/legacy labels coerced the same way the rest of the console coerces them. Exact.</p>
     </div>

     <div class="card" data-testid="growth-trials">
       <h2>Trial pipeline</h2>
       <div class="statgrid">
         ${stat(`Trials ending ≤${TRIAL_HORIZON_DAYS}d`, trials.trialsExpiringSoon)}
         ${stat("Paying subscribers", trials.subscribers, "paid plan + live subscription")}
         ${stat("Comped", trials.comps, "paid plan, no subscription")}
         ${stat("Scheduled churn", trials.scheduledChurn, "downgrade already booked")}
       </div>
       <p class="how">How measured: a trial is "ending" when <code>plan_downgrade_at</code> falls within ${TRIAL_HORIZON_DAYS} days (this includes any already past due and waiting on the hourly sweep). A subscriber is on a PAID PLAN <em>and</em> carries a <code>stripe_subscription_id</code>; a comp is a paid plan with none. <strong>The plan half of that is load-bearing</strong>: the subscription id is write-once and never cleared, so a churned account keeps its old id forever on the expired floor &mdash; counting the id alone would report everyone who has EVER paid, a number that can only ever go up. <strong>Scheduled churn excludes trials on purpose</strong>: every new account is written with <code>pending_plan='expired'</code> because that flag IS the trial clock, so counting it unqualified would just re-report the trial cohort. (The clock length is stamped per row at signup &mdash; new signups get ${TRIAL_DURATION_DAYS} days, but rows written under an earlier setting keep whatever they were stamped with, so a mixed cohort is expected and counted correctly either way.) Here it means a paid or comped account with a downgrade on the books.</p>
     </div>

     <div class="card">
       <h2>Campaign &mdash; promo redemptions</h2>
       <p class="muted" style="margin:.1rem 0 .3rem">All time: ${promoTotalLine}</p>
       <div class="tablewrap"><table class="fleet bars">
         <thead><tr><th>Day</th><th>Code</th><th>Redemptions</th></tr></thead>
         <tbody>${promoRows}</tbody>
       </table></div>
       <p class="how">How measured: one row per redemption in <code>promo_redemptions</code>, counted by code and UTC day, newest first. One promo per account forever, so a redemption is an account. Exact.</p>
     </div>

     <div class="card">
       <h2>What this page can see</h2>
       <p class="privacy" data-testid="growth-privacy">${GROWTH_PRIVACY_FOOTER}</p>
     </div>`,
  );
}
