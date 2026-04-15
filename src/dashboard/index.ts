/**
 * User dashboard — minimal server-rendered HTML.
 *
 * Plain template strings, no JSX. Admin surface only; keep it boring.
 */

import { Hono } from "hono";
import type { Env } from "../env.js";
import { clerkMiddleware, type AuthedContext } from "../auth/clerk.js";
import { listVaultsByOwner, getVaultById } from "../db/vaults.js";
import { getActiveSubscription } from "../db/subscriptions.js";
import { provisionVault, ProvisionError } from "../signup/provision.js";
import { tierOf, type TierId } from "../billing/tiers.js";
import { callVaultInternal } from "../vault-internal.js";

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
          Manage tokens from the vault's Tokens page.</p>
      </section>
      <script>
        try { history.replaceState(null, "", location.pathname); } catch {}
      </script>`
    : "";

  const rows = vaults
    .map(
      (v) => `
      <tr>
        <td><a href="https://${esc(v.hostname)}/">${esc(v.name)}</a></td>
        <td><code>${esc(v.hostname)}</code></td>
        <td>${new Date(v.created_at * 1000).toISOString().slice(0, 10)}</td>
        <td><a href="/dashboard/vaults/${esc(v.id)}/tokens">Tokens</a></td>
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
        <thead><tr><th>Name</th><th>Hostname</th><th>Created</th><th></th></tr></thead>
        <tbody>${rows || `<tr><td colspan="4"><em>No vaults yet.</em></td></tr>`}</tbody>
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

// ---- Token management ----
// One page per vault. Ownership is enforced on every route by loading the
// vault row and checking `owner_user_id === session user.id`. We return 404
// (not 403) for wrong-owner to avoid leaking which vault IDs exist.

type TokenRow = {
  id: string;
  name: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
};

async function loadOwnedVault(
  c: AuthedContext,
  vaultId: string,
): Promise<{ id: string; name: string; hostname: string } | null> {
  const user = c.get("user");
  const vault = await getVaultById(c.env.ACCOUNTS_DB, vaultId);
  if (!vault || vault.owner_user_id !== user.id) return null;
  return { id: vault.id, name: vault.name, hostname: vault.hostname };
}

dashboardApp.get("/vaults/:vaultId/tokens", async (c: AuthedContext) => {
  const user = c.get("user");
  const vault = await loadOwnedVault(c, c.req.param("vaultId") ?? "");
  if (!vault) return c.html(layout(user.email, `<p>Not found. <a href="/dashboard">Back</a></p>`), 404);

  const sub = await getActiveSubscription(c.env.ACCOUNTS_DB, user.id);
  const tier = (sub?.tier ?? "free") as TierId;

  const listRes = await callVaultInternal(c.env, vault.id, {
    method: "GET",
    path: "/_internal/tokens",
    tier,
  });
  if (!listRes.ok) {
    return c.html(layout(user.email, `<p style="color:crimson">Could not load tokens: ${listRes.status}</p>`), 502);
  }
  const { tokens } = (await listRes.json()) as { tokens: TokenRow[] };

  const url = new URL(c.req.url);
  const revealedToken = url.searchParams.get("token");
  const revealedName = url.searchParams.get("name");
  const banner = revealedToken
    ? `<section style="border:2px solid #c30; padding:0.8rem 1rem; background:#fff6f4;">
        <h2 style="margin-top:0">New token${revealedName ? `: ${esc(revealedName)}` : ""}</h2>
        <p><strong>Save this token now — you won't see it again:</strong></p>
        <p><code style="font-size:1.1em; word-break:break-all;">${esc(revealedToken)}</code></p>
        <p>Use with <code>Authorization: Bearer &lt;token&gt;</code>.</p>
      </section>
      <script>
        // Strip token + name from the URL so they don't sit in the user's
        // local browser history. This doesn't help upstream logs (CF, any
        // intermediary), but the &lt;meta referrer=no-referrer&gt; in the
        // layout prevents leakage to outbound links from this page.
        try { history.replaceState(null, "", location.pathname); } catch {}
      </script>`
    : "";

  const rows = tokens
    .map((t) => {
      const created = new Date(t.created_at * 1000).toISOString().slice(0, 10);
      const lastUsed = t.last_used_at ? new Date(t.last_used_at * 1000).toISOString().slice(0, 10) : "—";
      const status = t.revoked_at
        ? `<span style="color:#888">revoked ${new Date(t.revoked_at * 1000).toISOString().slice(0, 10)}</span>`
        : `<form method="POST" action="/dashboard/vaults/${esc(vault.id)}/tokens/${esc(t.id)}/revoke" style="display:inline">
             <button type="submit" onclick="return confirm('Revoke token &quot;${esc(t.name)}&quot;? It cannot be undone.')">Revoke</button>
           </form>`;
      return `<tr>
        <td>${esc(t.name)}</td>
        <td><code>${esc(t.id.slice(0, 8))}…</code></td>
        <td>${created}</td>
        <td>${lastUsed}</td>
        <td>${status}</td>
      </tr>`;
    })
    .join("");

  return c.html(layout(
    user.email,
    `
    <p><a href="/dashboard">← All vaults</a></p>
    <header>
      <h2>${esc(vault.name)} <small style="color:#666">${esc(vault.hostname)}</small></h2>
      <p style="color:#666">Tier: <strong>${esc(tier)}</strong></p>
    </header>
    ${banner}
    <section>
      <h3>API tokens</h3>
      <table>
        <thead><tr><th>Name</th><th>ID</th><th>Created</th><th>Last used</th><th></th></tr></thead>
        <tbody>${rows || `<tr><td colspan="5"><em>No tokens.</em></td></tr>`}</tbody>
      </table>
    </section>
    <section>
      <h3>Create a new token</h3>
      <form method="POST" action="/dashboard/vaults/${esc(vault.id)}/tokens">
        <label>Name: <input name="name" required maxlength="60" placeholder="laptop" /></label>
        <button type="submit">Create</button>
      </form>
      <p style="color:#666">The token value is shown once. Revoke it if you lose the device — revoking the last token won't lock you out (create a new one first if you still need access).</p>
    </section>
    `,
  ));
});

dashboardApp.post("/vaults/:vaultId/tokens", async (c: AuthedContext) => {
  const user = c.get("user");
  const vault = await loadOwnedVault(c, c.req.param("vaultId") ?? "");
  if (!vault) return c.html(layout(user.email, `<p>Not found.</p>`), 404);

  const form = await c.req.formData();
  const name = String(form.get("name") ?? "").trim().slice(0, 60) || "default";
  const sub = await getActiveSubscription(c.env.ACCOUNTS_DB, user.id);
  const tier = (sub?.tier ?? "free") as TierId;

  const res = await callVaultInternal(c.env, vault.id, {
    method: "POST",
    path: "/_internal/tokens",
    body: { name },
    tier,
  });
  if (!res.ok) {
    return c.html(layout(user.email, `<p style="color:crimson">Token create failed: ${res.status}</p>`), 502);
  }
  const { token } = (await res.json()) as { token: string };
  return c.redirect(
    `/dashboard/vaults/${encodeURIComponent(vault.id)}/tokens` +
    `?token=${encodeURIComponent(token)}&name=${encodeURIComponent(name)}`,
  );
});

dashboardApp.post("/vaults/:vaultId/tokens/:tokenId/revoke", async (c: AuthedContext) => {
  const user = c.get("user");
  const vault = await loadOwnedVault(c, c.req.param("vaultId") ?? "");
  if (!vault) return c.html(layout(user.email, `<p>Not found.</p>`), 404);

  const sub = await getActiveSubscription(c.env.ACCOUNTS_DB, user.id);
  const tier = (sub?.tier ?? "free") as TierId;

  const tokenId = c.req.param("tokenId") ?? "";
  const res = await callVaultInternal(c.env, vault.id, {
    method: "POST",
    path: `/_internal/tokens/${encodeURIComponent(tokenId)}/revoke`,
    tier,
  });
  if (!res.ok) {
    return c.html(layout(user.email, `<p style="color:crimson">Revoke failed: ${res.status}</p>`), 502);
  }
  return c.redirect(`/dashboard/vaults/${encodeURIComponent(vault.id)}/tokens`);
});

function layout(email: string, body: string): string {
  return `<!doctype html>
<html><head>
<meta charset="utf-8" />
<meta name="referrer" content="no-referrer" />
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
