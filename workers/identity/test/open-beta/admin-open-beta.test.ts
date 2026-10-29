/**
 * T-318 open beta, the OPERATOR view. Runs in the `identity-open-beta` project
 * (BILLING_MODE="open_beta"; vitest.config.ts), real D1 through the real
 * worker fetch, as an operator session.
 *
 * In open beta a lifted account keeps the stored plan id `trial` (rollback
 * safety) but has no clock. The admin pages must say what is true: those rows
 * are "Open beta", there is no trial pipeline to count, and paid rows still
 * read as their paid plan. The paid-mode wording ("Trial", "Trials ending")
 * stays pinned in admin.test.ts / admin-growth.test.ts (the `identity` project).
 */
import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import app from "../../src/index.ts";
import { CSRF, ISSUER, seedSession, seedUser, seedVault } from "../helpers.ts";

const DAY = 86_400_000;

function get(path: string, cookie: string): Request {
  return new Request(`${ISSUER}${path}`, { headers: { cookie } });
}

async function seedOperator(email: string): Promise<string> {
  const { id } = await seedUser(email);
  await env.DB.prepare("UPDATE users SET role = 'operator' WHERE id = ?").bind(id).run();
  return `parachute_id_csrf=${CSRF}; parachute_id_session=${await seedSession(id)}`;
}

async function html(path: string, cookie: string): Promise<string> {
  const res = await app.fetch(get(path, cookie), env);
  expect(res.status, path).toBe(200);
  return res.text();
}

/** The page's visible words: tags, comments and attribute values stripped. */
function visibleText(page: string): string {
  return page
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
}

/**
 * The fleet a newcomer operator sees mid-beta: the operator (a fresh beta
 * signup), a second fresh signup, a trial row the lift has NOT reached yet (old
 * clock still stamped), an `expired` row not yet lifted, a paying subscriber
 * mid-cancellation, and a comp.
 */
async function seedFleet(): Promise<string> {
  const cookie = await seedOperator("beta-op@example.com");
  const { id: fresh } = await seedUser("beta-fresh@example.com");
  await seedVault("beta-fresh-box", fresh);
  const now = new Date().toISOString();
  const soon = new Date(Date.now() + 2 * DAY).toISOString();
  const later = new Date(Date.now() + 20 * DAY).toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO users (id, email, password_hash, created_at, plan, pending_plan, plan_downgrade_at) VALUES ('ob-clock', 'ob-clock@example.com', '', ?, 'trial', 'expired', ?)",
    ).bind(now, soon),
    env.DB.prepare(
      "INSERT INTO users (id, email, password_hash, created_at, plan) VALUES ('ob-exp', 'ob-exp@example.com', '', ?, 'expired')",
    ).bind(now),
    env.DB.prepare(
      "INSERT INTO users (id, email, password_hash, created_at, plan, stripe_subscription_id, pending_plan, plan_downgrade_at) VALUES ('ob-sub', 'ob-sub@example.com', '', ?, 'standard', 'sub_ob', 'expired', ?)",
    ).bind(now, later),
    env.DB.prepare(
      "INSERT INTO users (id, email, password_hash, created_at, plan) VALUES ('ob-comp', 'ob-comp@example.com', '', ?, 'plus')",
    ).bind(now),
  ]);
  return cookie;
}

/** One rendered /admin/users row, found by its email. */
function userRow(page: string, email: string): string {
  const row = page.split('data-testid="admin-user-row"').find((r) => r.includes(`>${email}`));
  expect(row, email).toBeDefined();
  return row!.split("</tr>")[0]!;
}

describe("admin pages in open beta tell the truth about plans", () => {
  test("no admin page says Trial or counts trials", async () => {
    const cookie = await seedFleet();
    for (const path of ["/admin", "/admin/growth", "/admin/users", "/admin/vaults"]) {
      const text = visibleText(await html(path, cookie));
      expect(text, path).not.toMatch(/\btrials?\b/i);
    }
  });

  test("/admin/users: beta rows read Open beta, paid rows keep their plan, no expired floor", async () => {
    const cookie = await seedFleet();
    const page = await html("/admin/users", cookie);

    expect(userRow(page, "beta-fresh@example.com")).toContain("<td>Open beta</td>");
    expect(userRow(page, "ob-clock@example.com")).toContain("<td>Open beta</td>");
    // Not lifted yet: the operator sees it reads as the beta AND what is stored.
    expect(userRow(page, "ob-exp@example.com")).toContain("<td>Open beta (stored as expired)</td>");
    expect(userRow(page, "ob-sub@example.com")).toContain("<td>Standard</td>");
    expect(userRow(page, "ob-comp@example.com")).toContain("<td>Plus</td>");

    // A booked downgrade lands on the beta, not on a frozen floor.
    expect(userRow(page, "ob-sub@example.com")).toContain("downgrade scheduled &rarr; Open beta");
    // An un-lifted trial clock is not a downgrade in open beta.
    expect(userRow(page, "ob-clock@example.com")).not.toContain("downgrade scheduled");
    // The comp lever names what the floor means now; it never offers "Expired".
    expect(page).not.toContain("&rarr; Expired</button>");
    expect(userRow(page, "ob-comp@example.com")).toContain("&rarr; Open beta</button>");
  });

  test("/admin/growth: plan mix says Open beta, the money card counts paid accounts only", async () => {
    const cookie = await seedFleet();
    const page = await html("/admin/growth", cookie);

    // operator + fresh + the un-lifted clocked trial = 3 stored as `trial`.
    expect(page).toContain('<td>Open beta</td>\n        <td style="text-align:right">3</td>');
    expect(page).toContain('<td>Open beta (stored as expired)</td>\n        <td style="text-align:right">1</td>');
    expect(page).toContain('<td>Standard</td>\n        <td style="text-align:right">1</td>');
    expect(page).toContain('<td>Plus</td>\n        <td style="text-align:right">1</td>');

    expect(page).not.toContain("Trial pipeline");
    expect(page).not.toContain("Trials ending");
    expect(page).toContain("<h2>Paid accounts</h2>");
    expect(page).toContain('<div class="v">1</div><div class="sub">paid plan + live subscription</div>');
    expect(page).toContain('<div class="v">1</div><div class="sub">paid plan, no subscription</div>');
    expect(page).toContain('<div class="v">1</div><div class="sub">downgrade already booked</div>');
    expect(page).toContain("Free during the open beta.");
  });
});
