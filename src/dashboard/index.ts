/**
 * User dashboard — minimal server-rendered HTML.
 *
 * Plain template strings, no JSX. Admin surface only; keep it boring.
 */

import { Hono } from "hono";
import type { Env } from "../env.js";
import { clerkMiddleware, type AuthedContext } from "../auth/clerk.js";
import { listVaultsByOwner } from "../db/vaults.js";
import { getActiveSubscription } from "../db/subscriptions.js";
import { provisionVault, ProvisionError } from "../signup/provision.js";
import { tierOf, type TierId } from "../billing/tiers.js";

export const dashboardApp = new Hono<{
  Bindings: Env;
  Variables: { session: { clerkUserId: string; email: string }; user: import("../db/users.js").UserRow };
}>();

dashboardApp.use("*", clerkMiddleware());

dashboardApp.get("/", async (c: AuthedContext) => {
  const user = c.get("user");
  const vaults = await listVaultsByOwner(c.env.ACCOUNTS_DB, user.id);
  // Tier is sourced from the active Stripe subscription, NOT `users.tier`.
  // `users.tier` exists only as a legacy column and is ignored by the
  // authorization path; pay events flow through Stripe webhooks → `subscriptions`.
  const sub = await getActiveSubscription(c.env.ACCOUNTS_DB, user.id);
  const tier = (sub?.tier ?? "free") as TierId;
  const limits = tierOf(tier);

  const url = new URL(c.req.url);
  const createdHost = url.searchParams.get("created");
  const apiToken = url.searchParams.get("token");
  const tokenBanner = createdHost && apiToken
    ? `<section style="border:2px solid #c30; padding:0.8rem 1rem; background:#fff6f4;">
        <h2 style="margin-top:0">New vault: ${esc(createdHost)}</h2>
        <p><strong>Save this API token now — it will not be shown again:</strong></p>
        <p><code style="font-size:1.1em; word-break:break-all;">${esc(apiToken)}</code></p>
        <p style="color:#666">Use with <code>Authorization: Bearer &lt;token&gt;</code>.
          If you lose it, create a new one from the token management page (coming soon).</p>
      </section>`
    : "";

  const rows = vaults
    .map(
      (v) => `
      <tr>
        <td><a href="https://${esc(v.hostname)}/">${esc(v.name)}</a></td>
        <td><code>${esc(v.hostname)}</code></td>
        <td>${new Date(v.created_at * 1000).toISOString().slice(0, 10)}</td>
      </tr>`,
    )
    .join("");

  return c.html(layout(
    user.email,
    `
    ${tokenBanner}
    <section>
      <h2>Your vaults <small>(${vaults.length} / ${limits.maxVaults})</small></h2>
      <table>
        <thead><tr><th>Name</th><th>Hostname</th><th>Created</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="3"><em>No vaults yet.</em></td></tr>`}</tbody>
      </table>
    </section>

    <section>
      <h2>Create a new vault</h2>
      <form method="POST" action="/dashboard/vaults">
        <label>Subdomain: <input name="name" required pattern="[a-z0-9][a-z0-9-]{1,30}[a-z0-9]" /></label>
        <button type="submit">Create</button>
      </form>
    </section>

    <section>
      <h2>Plan</h2>
      <p><strong>${esc(limits.label)}</strong> — $${limits.priceUsdPerMonth}/mo</p>
      <p>${limits.maxVaults} vault(s), ${limits.storagePerVaultMb} MB / vault, ${limits.maxNotesPerVault.toLocaleString()} notes / vault.</p>
      <p><em>Billing portal coming soon.</em></p>
    </section>
    `,
  ));
});

dashboardApp.post("/vaults", async (c: AuthedContext) => {
  const user = c.get("user");
  const form = await c.req.formData();
  const name = String(form.get("name") ?? "");
  const sub = await getActiveSubscription(c.env.ACCOUNTS_DB, user.id);
  const tier = (sub?.tier ?? "free") as TierId;
  try {
    const { hostname, apiToken } = await provisionVault(c.env, user, name, tier);
    return c.redirect(
      `/dashboard?created=${encodeURIComponent(hostname)}&token=${encodeURIComponent(apiToken)}`,
    );
  } catch (err) {
    if (err instanceof ProvisionError) {
      return c.html(layout(user.email, `<p style="color:crimson">Error: ${esc(err.message)}</p><p><a href="/dashboard">Back</a></p>`), 400);
    }
    throw err;
  }
});

function layout(email: string, body: string): string {
  return `<!doctype html>
<html><head>
<meta charset="utf-8" />
<title>Parachute Cloud</title>
<style>
  body { font: 14px/1.5 system-ui, sans-serif; max-width: 760px; margin: 2rem auto; padding: 0 1rem; color: #222; }
  h1 { margin-bottom: 0; }
  header small { color: #666; }
  section { margin: 2rem 0; padding-top: 1rem; border-top: 1px solid #eee; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 0.4rem 0.5rem; border-bottom: 1px solid #eee; }
  form label { display: inline-block; margin-right: 0.5rem; }
  input { padding: 0.3rem 0.5rem; font: inherit; }
  button { padding: 0.3rem 0.8rem; font: inherit; cursor: pointer; }
  code { background: #f4f4f4; padding: 0 0.2rem; }
</style>
</head><body>
<header>
  <h1>Parachute Cloud</h1>
  <small>Signed in as ${esc(email)}</small>
</header>
${body}
</body></html>`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" :
    c === "<" ? "&lt;" :
    c === ">" ? "&gt;" :
    c === '"' ? "&quot;" : "&#39;");
}
