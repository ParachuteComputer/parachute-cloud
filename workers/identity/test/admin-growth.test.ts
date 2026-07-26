/**
 * The Growth panel (/admin/growth) — the operator gate, the four cards, and the
 * privacy pin.
 *
 * Pins:
 *   - 404-POSTURE PARITY with the rest of /admin: no session, a plain-user
 *     session, and an EXPIRED session all get the router's own byte-identical
 *     404. Not a 403, not a login redirect — the surface never reveals itself.
 *   - each card renders from real seeded rows: the arrival tiles + the 12-week
 *     sparkline, both funnel cohorts with their five stages (and the young
 *     cohort's week-2 stage grayed "too young"), plan mix, the trial pipeline
 *     counts, and the campaign ledger.
 *   - the activation proxies actually fire: checklist-based content, byte-growth
 *     content, the non-console token/grant "connected AI" signal, and each of
 *     the three week-2 return signals.
 *   - THE PRIVACY PIN: given seeded users whose emails are in the database and
 *     provably renderable (the positive control loads /admin/users and finds
 *     them there), the Growth page's HTML contains NO email address at all —
 *     neither a seeded one nor anything matching an email shape. Without the
 *     positive control the negative assertion would be vacuous.
 */
import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import app from "../src/index.ts";
import { CONSOLE_CLIENT_ID } from "../src/drip.ts";
import { CONTENT_GROWTH_BYTES } from "../src/admin-growth.ts";
import { GROWTH_PRIVACY_FOOTER } from "../src/admin-growth-ui.ts";
import { TRIAL_DURATION_DAYS } from "../src/plans.ts";
import { SESSION_TTL_MS } from "../src/sessions.ts";
import { REFRESH_TOKEN_TTL_MS } from "../src/tokens.ts";
import { CSRF, ISSUER, seedSession, seedUser, seedVault } from "./helpers.ts";

const DAY_MS = 86_400_000;
const GROWTH = "/admin/growth";

function get(path: string, cookie?: string): Request {
  return new Request(`${ISSUER}${path}`, { headers: cookie ? { cookie } : {} });
}

function cookieFor(sessionId: string): string {
  return `parachute_id_csrf=${CSRF}; parachute_id_session=${sessionId}`;
}

async function seedOperator(email: string): Promise<{ id: string; cookie: string }> {
  const { id } = await seedUser(email);
  await env.DB.prepare("UPDATE users SET role = 'operator' WHERE id = ?").bind(id).run();
  return { id, cookie: cookieFor(await seedSession(id)) };
}

/** A bare users row at an arbitrary age — no trial clock, no plan noise. */
async function seedUserAged(id: string, email: string, daysAgo: number): Promise<string> {
  await env.DB.prepare("INSERT INTO users (id, email, password_hash, created_at, plan) VALUES (?, ?, '', ?, 'trial')")
    .bind(id, email, new Date(Date.now() - daysAgo * DAY_MS).toISOString())
    .run();
  return id;
}

async function growthHtml(cookie: string): Promise<string> {
  const res = await app.fetch(get(GROWTH, cookie), env);
  expect(res.status).toBe(200);
  return res.text();
}

/** Count `data-testid="X"` occurrences in rendered HTML. */
function marks(html: string, testid: string): number {
  return html.match(new RegExp(`data-testid="${testid}"`, "g"))?.length ?? 0;
}

// --- the gate ------------------------------------------------------------------

describe("GET /admin/growth — the operator gate (404 posture parity)", () => {
  test("no session → the router's own 404, byte-identical to an unknown path", async () => {
    const res = await app.fetch(get(GROWTH), env);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("404 Not Found");
    const unknown = await app.fetch(get("/definitely-not-a-route"), env);
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toBe("404 Not Found");
  });

  test("a plain user session → still 404 (not 403, not a login redirect)", async () => {
    const { id } = await seedUser("growth-plain@example.com");
    const res = await app.fetch(get(GROWTH, cookieFor(await seedSession(id))), env);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("404 Not Found");
    expect(res.headers.get("location")).toBeNull();
  });

  test("an EXPIRED operator session → 404; the same operator with a live session → 200", async () => {
    const { id, cookie } = await seedOperator("growth-expired-op@example.com");
    expect((await app.fetch(get(GROWTH, cookie), env)).status).toBe(200);

    const dead = await seedSession(id);
    await env.DB.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - DAY_MS).toISOString(), dead)
      .run();
    const res = await app.fetch(get(GROWTH, cookieFor(dead)), env);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("404 Not Found");
  });

  test("the Growth link sits in the admin nav on every admin page", async () => {
    const { cookie } = await seedOperator("growth-nav-op@example.com");
    for (const path of ["/admin", "/admin/users", "/admin/vaults"]) {
      const html = await (await app.fetch(get(path, cookie), env)).text();
      expect(html, path).toContain(`href="/admin/growth"`);
    }
    // On the panel itself the nav entry is the current section, not a link.
    expect(await growthHtml(cookie)).toContain("<strong>Growth</strong>");
  });
});

// --- arrival --------------------------------------------------------------------

describe("the Arrival card", () => {
  test("7d / 30d / week-over-week tiles and a 12-week sparkline", async () => {
    const { cookie } = await seedOperator("arrival-op@example.com");
    // 3 signups inside the last 7 days, 1 in the 7 days before that, 1 old
    // enough to sit inside the 30d window but outside both weeks.
    await seedUserAged("arr-a", "arr-a@example.com", 1);
    await seedUserAged("arr-b", "arr-b@example.com", 2);
    await seedUserAged("arr-c", "arr-c@example.com", 3);
    await seedUserAged("arr-d", "arr-d@example.com", 9);
    await seedUserAged("arr-e", "arr-e@example.com", 20);

    const html = await growthHtml(cookie);
    expect(html).toContain("Arrival");
    // The operator seeded above is itself a signup made "now" → 4 in 7d.
    expect(html).toContain("<div class=\"k\">Signups 7d</div><div class=\"v\">4</div>");
    expect(html).toContain("1 the 7 days before");
    expect(html).toContain("<div class=\"k\">Signups 30d</div><div class=\"v\">6</div>");
    expect(html).toContain("+3"); // week over week: 4 − 1

    // One sparkline, 12 weekly values in its accessible label, no <script>.
    expect(marks(html, "growth-sparkline")).toBe(1);
    const label = html.match(/aria-label="Signups per week, 12 weeks, oldest to newest: ([^"]+)"/);
    expect(label).not.toBeNull();
    expect(label![1]!.split(", ")).toHaveLength(12);
    expect(html).toContain("<polyline");
    expect(html).not.toContain("<script");

    // The honest limit is stated, not implied.
    expect(html).toContain("No acquisition-source data is captured anywhere in this system");
  });
});

// --- the activation funnel ---------------------------------------------------------

describe("the Activation funnel", () => {
  test("both cohorts render five stages; the young cohort's week-2 stage is grayed 'too young'", async () => {
    const { cookie } = await seedOperator("funnel-shape-op@example.com");
    await seedUserAged("fs-young", "fs-young@example.com", 3);
    await seedUserAged("fs-mature", "fs-mature@example.com", 30);

    const html = await growthHtml(cookie);
    expect(marks(html, "growth-cohort")).toBe(2);
    expect(marks(html, "growth-stage")).toBe(10); // 5 stages × 2 cohorts
    expect(html).toContain("Signed up in the last 14 days");
    expect(html).toContain("Signed up 14–44 days ago");
    // Exactly one "too young" stage — the young cohort's week-2 row.
    expect(html.match(/too young/g)).toHaveLength(1);
    expect(html).toContain('class="stage stage-muted"');
    // Stages are labelled and the independence caveat is on the page.
    for (const label of ["Created a vault", "Has content", "Connected an AI", "Came back in week 2"]) {
      expect(html, label).toContain(label);
    }
    expect(html).toContain("measured INDEPENDENTLY, not nested");
    // Has-content is a two-sided proxy and the copy must name BOTH directions:
    // the checklist branch counts a click, the byte branch can't see a vault's
    // first rollup at all.
    expect(html).toContain("records a CLICK on the checklist door rather than a saved note");
    expect(html).toContain("the earliest rollup IS the baseline");
  });

  test("created-vault + has-content: the checklist path and the byte-growth path both count", async () => {
    const { cookie } = await seedOperator("funnel-content-op@example.com");
    const now = new Date().toISOString();

    // A: vault + a write-note checklist row → content via the checklist.
    await seedUserAged("fc-a", "fc-a@example.com", 20);
    await seedVault("fc-a-box", "fc-a");
    await env.DB.prepare("INSERT INTO user_checklist (user_id, item, done_at) VALUES ('fc-a', 'write-note', ?)")
      .bind(now)
      .run();

    // B: vault + rollup rows that grew past the threshold → content via bytes.
    await seedUserAged("fc-b", "fc-b@example.com", 21);
    await seedVault("fc-b-box", "fc-b");
    await env.DB.batch([
      env.DB.prepare("INSERT INTO vault_usage (vault_name, day, db_bytes, r2_bytes) VALUES ('fc-b-box', '2026-01-01', 1000, 0)"),
      env.DB.prepare("INSERT INTO vault_usage (vault_name, day, db_bytes, r2_bytes) VALUES ('fc-b-box', '2026-01-05', ?, 0)").bind(
        1000 + CONTENT_GROWTH_BYTES + 1,
      ),
    ]);

    // C: vault + rollups that barely moved → NOT content (under the threshold).
    await seedUserAged("fc-c", "fc-c@example.com", 22);
    await seedVault("fc-c-box", "fc-c");
    await env.DB.batch([
      env.DB.prepare("INSERT INTO vault_usage (vault_name, day, db_bytes, r2_bytes) VALUES ('fc-c-box', '2026-01-01', 1000, 0)"),
      env.DB.prepare("INSERT INTO vault_usage (vault_name, day, db_bytes, r2_bytes) VALUES ('fc-c-box', '2026-01-05', 1500, 0)"),
    ]);

    // D: no vault at all — the funnel's first drop-off.
    await seedUserAged("fc-d", "fc-d@example.com", 23);

    const html = await growthHtml(cookie);
    const mature = html.split('data-testid="growth-cohort"')[2]!; // [0]=preamble, [1]=young, [2]=mature
    expect(mature).toContain("4 accounts in this cohort");
    expect(mature).toMatch(/Created a vault<\/span><span class="stagenum">3 /);
    expect(mature).toMatch(/Has content<\/span><span class="stagenum">2 /);
  });

  test("connected-AI counts a non-console token OR grant, and never the console's own client", async () => {
    const { cookie } = await seedOperator("funnel-ai-op@example.com");
    const expires = new Date(Date.now() + DAY_MS).toISOString();
    const now = new Date().toISOString();

    await seedUserAged("fa-token", "fa-token@example.com", 20);
    await env.DB.prepare(
      "INSERT INTO tokens (jti, user_id, client_id, scopes, expires_at, created_at) VALUES ('fa-jti', 'fa-token', 'some-ai-client', 'vault:x:read', ?, ?)",
    )
      .bind(expires, now)
      .run();

    await seedUserAged("fa-grant", "fa-grant@example.com", 21);
    await env.DB.prepare(
      "INSERT INTO grants (user_id, client_id, scopes, granted_at) VALUES ('fa-grant', 'another-ai-client', 'vault:x:read', ?)",
    )
      .bind(now)
      .run();

    // The console's own internal mint must NOT read as "connected an AI" — the
    // product talking to itself (the exact drip.ts exclusion).
    await seedUserAged("fa-console", "fa-console@example.com", 22);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO tokens (jti, user_id, client_id, scopes, expires_at, created_at) VALUES ('fa-console-jti', 'fa-console', ?, 'vault:x:read', ?, ?)",
      ).bind(CONSOLE_CLIENT_ID, expires, now),
      env.DB.prepare("INSERT INTO grants (user_id, client_id, scopes, granted_at) VALUES ('fa-console', ?, 'vault:x:read', ?)").bind(
        CONSOLE_CLIENT_ID,
        now,
      ),
    ]);

    const mature = (await growthHtml(cookie)).split('data-testid="growth-cohort"')[2]!;
    expect(mature).toContain("3 accounts in this cohort");
    expect(mature).toMatch(/Connected an AI<\/span><span class="stagenum">2 /);
  });

  test("week-2 return: a session row, a token row, or a usage delta inside the account's own days 7–14", async () => {
    const { cookie } = await seedOperator("funnel-w2-op@example.com");
    const signupDaysAgo = 30;
    const signupAt = Date.now() - signupDaysAgo * DAY_MS;
    /** An ISO timestamp `d` days after that account's signup. */
    const afterSignup = (d: number) => new Date(signupAt + d * DAY_MS).toISOString();
    const dayAfterSignup = (d: number) => afterSignup(d).slice(0, 10);

    await seedUserAged("w2-session", "w2-session@example.com", signupDaysAgo);
    await env.DB.prepare("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES ('w2-sess', 'w2-session', ?, ?)")
      .bind(afterSignup(9), new Date(Date.now() + DAY_MS).toISOString())
      .run();

    await seedUserAged("w2-token", "w2-token@example.com", signupDaysAgo);
    await env.DB.prepare(
      "INSERT INTO tokens (jti, user_id, client_id, scopes, expires_at, created_at) VALUES ('w2-jti', 'w2-token', 'ai', 's', ?, ?)",
    )
      .bind(new Date(Date.now() + DAY_MS).toISOString(), afterSignup(10))
      .run();

    await seedUserAged("w2-usage", "w2-usage@example.com", signupDaysAgo);
    await seedVault("w2-usage-box", "w2-usage");
    await env.DB.batch([
      env.DB.prepare("INSERT INTO vault_usage (vault_name, day, db_bytes, r2_bytes) VALUES ('w2-usage-box', ?, 1000, 0)").bind(
        dayAfterSignup(8),
      ),
      env.DB.prepare("INSERT INTO vault_usage (vault_name, day, db_bytes, r2_bytes) VALUES ('w2-usage-box', ?, 90000, 0)").bind(
        dayAfterSignup(12),
      ),
    ]);

    // A control that must NOT count: activity on day 3, outside the window.
    await seedUserAged("w2-early", "w2-early@example.com", signupDaysAgo);
    await env.DB.prepare("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES ('w2-early-sess', 'w2-early', ?, ?)")
      .bind(afterSignup(3), new Date(Date.now() + DAY_MS).toISOString())
      .run();

    const mature = (await growthHtml(cookie)).split('data-testid="growth-cohort"')[2]!;
    expect(mature).toContain("4 accounts in this cohort");
    expect(mature).toMatch(/Came back in week 2<\/span><span class="stagenum">3 /);
  });
});

// --- plan mix + trial pipeline -------------------------------------------------------

describe("Plan mix + the trial pipeline", () => {
  test("plan rows, subscriber/comp split, trials ending soon, and trial-excluded scheduled churn", async () => {
    const { cookie } = await seedOperator("plan-op@example.com");
    const soon = new Date(Date.now() + 2 * DAY_MS).toISOString();
    const later = new Date(Date.now() + 20 * DAY_MS).toISOString();

    await env.DB.batch([
      // A trial whose clock runs out inside the horizon, and one that doesn't.
      env.DB.prepare(
        "INSERT INTO users (id, email, password_hash, created_at, plan, pending_plan, plan_downgrade_at) VALUES ('pm-t1', 'pm-t1@example.com', '', ?, 'trial', 'expired', ?)",
      ).bind(new Date().toISOString(), soon),
      env.DB.prepare(
        "INSERT INTO users (id, email, password_hash, created_at, plan, pending_plan, plan_downgrade_at) VALUES ('pm-t2', 'pm-t2@example.com', '', ?, 'trial', 'expired', ?)",
      ).bind(new Date().toISOString(), later),
      // A real subscriber.
      env.DB.prepare(
        "INSERT INTO users (id, email, password_hash, created_at, plan, stripe_subscription_id) VALUES ('pm-sub', 'pm-sub@example.com', '', ?, 'standard', 'sub_123')",
      ).bind(new Date().toISOString()),
      // A comp: paid tier, no Stripe subscription — and a downgrade booked.
      env.DB.prepare(
        "INSERT INTO users (id, email, password_hash, created_at, plan, pending_plan, plan_downgrade_at) VALUES ('pm-comp', 'pm-comp@example.com', '', ?, 'plus', 'expired', ?)",
      ).bind(new Date().toISOString(), later),
    ]);

    const html = await growthHtml(cookie);
    // Plan mix: 3 trials (the operator seeds one) + standard + plus.
    expect(marks(html, "growth-plan-row")).toBe(3);
    expect(html).toContain("<td>Trial</td>\n        <td style=\"text-align:right\">3</td>");
    expect(html).toContain("Share of 5");

    // Trial pipeline tiles.
    expect(html).toContain("<div class=\"v\">1</div><div class=\"sub\">paid plan + live subscription</div>");
    expect(html).toContain("<div class=\"v\">1</div><div class=\"sub\">paid plan, no subscription</div>");
    // Scheduled churn counts the comp's booked downgrade — and NOT the three
    // trials, which all carry pending_plan='expired' as their trial clock.
    expect(html).toContain("<div class=\"v\">1</div><div class=\"sub\">downgrade already booked</div>");
    expect(html).toContain("Scheduled churn excludes trials on purpose");
    // Trials ending within the 7-day horizon: pm-t1 only.
    expect(html).toContain("Trials ending ≤7d</div><div class=\"v\">1</div>");
  });

  test("a CHURNED subscriber does NOT count as paying — the subscription id is never cleared", async () => {
    const { cookie } = await seedOperator("churn-op@example.com");
    await env.DB.batch([
      // Live: on a paid plan AND carrying a subscription id.
      env.DB.prepare(
        "INSERT INTO users (id, email, password_hash, created_at, plan, stripe_subscription_id) VALUES ('ch-live', 'ch-live@example.com', '', ?, 'standard', 'sub_live')",
      ).bind(new Date().toISOString()),
      // Churned: the sweep dropped them to the expired floor, but
      // billing-lifecycle.ts never clears stripe_subscription_id — the stale id
      // survives forever (promo.ts's header documents exactly this). Keyed on
      // the id alone, this account would read as paying, permanently, and the
      // revenue tile could only ever ratchet up.
      env.DB.prepare(
        "INSERT INTO users (id, email, password_hash, created_at, plan, stripe_subscription_id) VALUES ('ch-dead', 'ch-dead@example.com', '', ?, 'expired', 'sub_dead')",
      ).bind(new Date().toISOString()),
    ]);

    const html = await growthHtml(cookie);
    expect(html).toContain("<div class=\"v\">1</div><div class=\"sub\">paid plan + live subscription</div>");
    // …and the copy names why the plan half of the predicate is load-bearing.
    expect(html).toContain("counting the id alone would report everyone who has EVER paid");
  });

  test("durations in the copy come from their defining constants, not literals", async () => {
    const { cookie } = await seedOperator("duration-op@example.com");
    const html = await growthHtml(cookie);
    // The trial length is in flight (30 → 90). A literal would go stale on the
    // one page whose entire premise is honest measurement.
    // The clock is stamped per row at signup, so the page must NOT claim one
    // length for the whole cohort — it names the length only for NEW signups.
    expect(html).toContain("IS the trial clock");
    expect(html).toContain(`new signups get ${TRIAL_DURATION_DAYS} days`);
    expect(html).toContain(`Session cookies last ${Math.round(SESSION_TTL_MS / DAY_MS)} days`);
    expect(html).toContain(`its ${Math.round(REFRESH_TOKEN_TTL_MS / DAY_MS)}-day refresh cycle`);
  });
});

// --- the campaign ledger ---------------------------------------------------------------

describe("the Campaign card", () => {
  test("redemptions per code per day, plus all-time totals", async () => {
    const { cookie } = await seedOperator("promo-op@example.com");
    await env.DB.batch([
      env.DB.prepare("INSERT INTO promo_redemptions (user_id, code, redeemed_at) VALUES ('pr-1', 'INDEPENDENCE', '2026-07-20T10:00:00.000Z')"),
      env.DB.prepare("INSERT INTO promo_redemptions (user_id, code, redeemed_at) VALUES ('pr-2', 'INDEPENDENCE', '2026-07-20T11:00:00.000Z')"),
      env.DB.prepare("INSERT INTO promo_redemptions (user_id, code, redeemed_at) VALUES ('pr-3', 'INDEPENDENCE', '2026-07-21T09:00:00.000Z')"),
      env.DB.prepare("INSERT INTO promo_redemptions (user_id, code, redeemed_at) VALUES ('pr-4', 'INTERDEPENDENCE', '2026-07-21T09:30:00.000Z')"),
    ]);

    const html = await growthHtml(cookie);
    expect(marks(html, "growth-promo-row")).toBe(3); // (07-20,IND) (07-21,IND) (07-21,INTER)
    expect(html).toContain("<td>2026-07-20</td>");
    expect(html).toContain("INDEPENDENCE");
    expect(html).toContain("INTERDEPENDENCE");
    expect(html).toContain("<code>INDEPENDENCE</code> 3"); // all-time total
    // The ledger's user_id column is never rendered.
    expect(html).not.toContain("pr-1");
  });

  test("an empty ledger says so instead of rendering a blank table", async () => {
    const { cookie } = await seedOperator("promo-empty-op@example.com");
    const html = await growthHtml(cookie);
    expect(html).toContain("No promo codes have been redeemed yet.");
    expect(html).toContain("No redemptions recorded.");
  });
});

// --- the privacy pin ---------------------------------------------------------------------

describe("PRIVACY — the Growth page renders counts, never a person", () => {
  test("no email address appears in the HTML, with a positive control proving the scan sees content", async () => {
    const { cookie } = await seedOperator("privacy-op@example.com");
    const emails = ["privacy-alice@example.com", "privacy-bob@example.com", "privacy-carol@example.com"];
    for (let i = 0; i < emails.length; i++) {
      const id = await seedUserAged(`priv-${i}`, emails[i]!, i + 1);
      await seedVault(`priv-box-${i}`, id);
      await env.DB.prepare("INSERT INTO user_checklist (user_id, item, done_at) VALUES (?, 'write-note', ?)")
        .bind(id, new Date().toISOString())
        .run();
      await env.DB.prepare("INSERT INTO promo_redemptions (user_id, code, redeemed_at) VALUES (?, 'INDEPENDENCE', ?)")
        .bind(id, new Date().toISOString())
        .run();
    }

    // POSITIVE CONTROL: the same scan, run over the operations table, DOES find
    // every one of these addresses. So a miss on the Growth page is a real
    // absence, not a broken assertion or an empty page.
    const usersHtml = await (await app.fetch(get("/admin/users", cookie), env)).text();
    for (const email of emails) expect(usersHtml, `control: ${email}`).toContain(email);
    expect(usersHtml).toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);

    const html = await growthHtml(cookie);
    // The page is genuinely rendered (not an error/empty body the scan would
    // trivially pass): its cards and its counts are present.
    expect(html.length).toBeGreaterThan(2000);
    expect(html).toContain("Activation funnel");
    expect(marks(html, "growth-cohort")).toBe(2);
    expect(marks(html, "growth-promo-row")).toBeGreaterThan(0);

    // THE PIN: no seeded address, no user id, no VAULT NAME, and nothing
    // email-SHAPED at all. Vault names are user-chosen free text and identify a
    // person just as well as an address does, so they are pinned explicitly
    // rather than left to the email-shape regex.
    for (const email of emails) expect(html, email).not.toContain(email);
    expect(html).not.toContain("privacy-op@example.com");
    expect(html).not.toContain("priv-0");
    expect(html).not.toContain("priv-box-");
    expect(html).not.toMatch(/[\w.+-]+@[\w-]+\.[\w-]+/);

    // Control: those vault names ARE renderable — /admin/vaults shows them.
    const vaultsHtml = await (await app.fetch(get("/admin/vaults", cookie), env)).text();
    expect(vaultsHtml).toContain("priv-box-0");
  });

  test("the privacy footer renders verbatim", async () => {
    const { cookie } = await seedOperator("privacy-copy-op@example.com");
    // The constant itself is pinned here, so the promise can't be quietly
    // softened in the view file without this test failing.
    expect(GROWTH_PRIVACY_FOOTER).toBe(
      "What this page never shows: note content, titles, or queries; any individual person's behavior or timeline; email addresses; IP addresses. Everything here is counts, cohorts, and buckets over data Parachute already keeps to run the service. Individual accounts appear only in Users/Vaults — the operations tables — for comp and suspend.",
    );
    const html = await growthHtml(cookie);
    expect(html).toContain(GROWTH_PRIVACY_FOOTER);
  });
});
