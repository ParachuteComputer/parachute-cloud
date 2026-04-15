/**
 * User dashboard + onboarding — server-rendered HTML.
 *
 * v0.4 shape:
 *   - GET /onboarding/choose-hostname   — hostname picker (first login)
 *   - POST /onboarding/choose-hostname  — calls onboardUser
 *   - GET /dashboard                    — vaults grid + tokens + billing + settings
 *   - POST /dashboard/vaults            — create extra vault for this user
 *   - POST /dashboard/vaults/:id/rename — rename
 *   - POST /dashboard/vaults/:id/delete — hard delete
 *   - POST /dashboard/tokens            — issue user or vault-scoped token
 *   - POST /dashboard/tokens/:id/revoke — revoke one token
 *
 * Security:
 *   - Token reveal goes through KV + HttpOnly cookie (see ./security.ts).
 *     The raw `pvt_…` token never appears in a redirect URL, so it can't
 *     leak into Worker access logs, Cloudflare logs, or browser history.
 *   - All POSTs are CSRF-checked via double-submit (cookie + hidden form
 *     field). 403 on mismatch.
 *
 * All `/dashboard/*` routes redirect to `/onboarding/choose-hostname` when
 * the user hasn't picked a hostname yet. Onboarding routes redirect the
 * other way once hostname is set.
 *
 * Plain template strings, no JSX. Forms post x-www-form-urlencoded.
 */

import { Hono } from "hono";
import type { Env } from "../env.js";
import { clerkMiddleware, type AuthedContext } from "../auth/clerk.js";
import {
  listVaultsByUser,
  countVaultsByUser,
  getVaultById,
  renameVault,
  hardDeleteVault,
  doIdName,
} from "../db/vaults.js";
import { getActiveSubscription } from "../db/subscriptions.js";
import {
  onboardUser,
  createVaultForUser,
  ProvisionError,
} from "../signup/provision.js";
import { tierOf, type TierId } from "../billing/tiers.js";
import { callVaultInternal } from "../vault-internal.js";
import {
  issueToken,
  listUserTokens,
  revokeUserToken,
} from "../auth/tokens.js";
import type { TokenRow } from "../db/tokens.js";
import {
  stashReveal,
  popReveal,
  ensureCsrfToken,
  csrfInput,
  csrfMiddleware,
  appendSetCookie,
  type RevealPayload,
} from "./security.js";

type Vars = {
  session: { clerkUserId: string; email: string };
  user: import("../db/users.js").UserRow;
};

export const dashboardApp = new Hono<{ Bindings: Env; Variables: Vars }>();

dashboardApp.use("*", clerkMiddleware());
// CSRF on every POST inside this router. GETs pass through.
dashboardApp.use("*", csrfMiddleware());

// Onboarding / dashboard guard: users without a hostname land on onboarding;
// users with one skip past it.
dashboardApp.use("*", async (c, next) => {
  const user = c.get("user");
  const path = new URL(c.req.url).pathname;
  const isOnboarding = path.startsWith("/onboarding");
  if (!user.hostname && !isOnboarding) {
    return c.redirect("/onboarding/choose-hostname");
  }
  if (user.hostname && isOnboarding) {
    return c.redirect("/dashboard");
  }
  return next();
});

// ---- Onboarding ----

dashboardApp.get("/choose-hostname", async (c: AuthedContext) => {
  const user = c.get("user");
  const err = new URL(c.req.url).searchParams.get("err");
  const csrf = ensureCsrfToken(c.req.header("Cookie") ?? null);
  if (csrf.setCookie) appendSetCookie(c, csrf.setCookie);
  return c.html(onboardingPage(user.email, c.env.ROOT_DOMAIN, err, csrf.token));
});

dashboardApp.post("/choose-hostname", async (c: AuthedContext) => {
  const user = c.get("user");
  const form = await c.req.formData();
  const subdomain = String(form.get("subdomain") ?? "");
  try {
    const result = await onboardUser(c.env, user, subdomain);
    const cookie = await stashReveal(c.env, {
      kind: "welcome",
      token: result.apiToken,
      hostname: result.hostname,
    });
    appendSetCookie(c, cookie);
    return c.redirect("/dashboard");
  } catch (err) {
    const msg = err instanceof ProvisionError ? err.message : "error";
    return c.redirect(`/onboarding/choose-hostname?err=${encodeURIComponent(msg)}`);
  }
});

// ---- Dashboard home ----

dashboardApp.get("/", async (c: AuthedContext) => {
  const user = c.get("user");
  const hostname = user.hostname!; // guard guarantees non-null
  const db = c.env.ACCOUNTS_DB;

  const csrf = ensureCsrfToken(c.req.header("Cookie") ?? null);
  if (csrf.setCookie) appendSetCookie(c, csrf.setCookie);

  // One-shot reveal (welcome banner OR new-token banner).
  const revealResult = await popReveal(c.env, c.req.header("Cookie") ?? null);
  if (revealResult) appendSetCookie(c, revealResult.clearCookie);
  const reveal = revealResult?.payload ?? null;

  const [vaults, sub, tokens] = await Promise.all([
    listVaultsByUser(db, user.id),
    getActiveSubscription(db, user.id),
    listUserTokens(db, user.id),
  ]);
  const tier = (sub?.tier ?? "free") as TierId;
  const limits = tierOf(tier);

  const url = new URL(c.req.url);
  const deleted = url.searchParams.get("deleted");
  const errMsg = url.searchParams.get("err");

  const banners = [
    reveal ? revealBanner(reveal) : "",
    deleted
      ? `<div class="banner banner-warn"><p>Deleted vault <code>${esc(deleted)}</code>.</p>
         <script>try { history.replaceState(null, "", "/dashboard"); } catch {}</script></div>`
      : "",
    errMsg
      ? `<div class="banner banner-warn"><p>${esc(errMsg)}</p>
         <script>try { history.replaceState(null, "", "/dashboard"); } catch {}</script></div>`
      : "",
  ].join("");

  // Vault cards
  const vaultCards = vaults.map((v) => {
    const created = dateStr(v.created_at);
    const vaultUrl = `https://${hostname}/v/${v.slug}`;
    return `
      <div class="card">
        <h3>${esc(v.name)}</h3>
        <div class="slug">/v/${esc(v.slug)}</div>
        <div class="meta">Created ${created}</div>
        <div class="actions">
          <a class="btn" href="#rename-${esc(v.id)}">Rename</a>
          <a class="btn btn-ghost" href="${esc(vaultUrl)}/mcp" title="MCP endpoint — coming in v0.5">MCP</a>
          <a class="btn btn-danger" href="#delete-${esc(v.id)}">Delete</a>
        </div>
      </div>
      ${renameModal(v.id, v.name, csrf.token)}
      ${deleteModal(v.id, v.name, v.slug, csrf.token)}
    `;
  }).join("");

  const vaultsSection = vaults.length > 0
    ? `<div class="grid">${vaultCards}</div>`
    : emptyVaultsState();

  // Tokens table
  const tokenRows = tokens.map((t) => tokenRow(t, csrf.token)).join("");
  const tokensSection = tokens.length > 0
    ? `<table>
        <thead><tr><th>Name</th><th>Scope</th><th>Created</th><th>Last used</th><th></th></tr></thead>
        <tbody>${tokenRows}</tbody>
      </table>`
    : `<div class="empty"><p>No tokens.</p></div>`;

  const vaultOpts = vaults.map((v) => `<option value="${esc(v.slug)}">${esc(v.name)} (/v/${esc(v.slug)})</option>`).join("");

  return c.html(layout(user.email, hostname, tier, `
    ${banners}

    <section class="hero">
      <h1>${esc(hostname)}</h1>
      <p>Your Parachute. Vaults, tokens, and plan — all in one place.</p>
    </section>

    <section>
      <header>
        <h2>Vaults <span class="pill">${vaults.length} / ${limits.maxVaults}</span></h2>
        <a class="btn btn-primary" href="#new-vault">New vault</a>
      </header>
      ${vaultsSection}
    </section>

    <section>
      <header>
        <h2>API tokens</h2>
        <a class="btn btn-primary" href="#new-token">New token</a>
      </header>
      ${tokensSection}
    </section>

    <section>
      <header><h2>Plan</h2></header>
      <div class="card">
        <h3>${esc(limits.label)} <span class="pill pill-turquoise">${esc(tier)}</span></h3>
        <div class="meta">$${limits.priceUsdPerMonth}/mo — ${limits.maxVaults} vault(s), ${limits.storagePerVaultMb} MB each, ${limits.maxNotesPerVault.toLocaleString()} notes/vault</div>
        <div class="actions"><span class="btn btn-ghost">Billing portal — soon</span></div>
      </div>
    </section>

    <section>
      <header><h2>Settings</h2></header>
      <div class="card">
        <h3>Account</h3>
        <div class="meta">Email: <code>${esc(user.email)}</code></div>
        <div class="meta">Hostname: <code>${esc(hostname)}</code></div>
      </div>
    </section>

    ${newVaultModal(csrf.token)}
    ${newTokenModal(vaultOpts, csrf.token)}
  `));
});

// ---- Vault create / rename / delete ----

dashboardApp.post("/vaults", async (c: AuthedContext) => {
  const user = c.get("user");
  const form = await c.req.formData();
  const name = String(form.get("name") ?? "").trim();
  const slug = String(form.get("slug") ?? "").trim();
  const sub = await getActiveSubscription(c.env.ACCOUNTS_DB, user.id);
  const tier = (sub?.tier ?? "free") as TierId;
  const limits = tierOf(tier);
  const count = await countVaultsByUser(c.env.ACCOUNTS_DB, user.id);
  if (count >= limits.maxVaults) {
    return c.redirect("/dashboard?err=" + encodeURIComponent("vault limit reached for plan"));
  }
  try {
    await createVaultForUser(c.env, user.id, name || slug, slug);
    return c.redirect("/dashboard");
  } catch (err) {
    const msg = err instanceof ProvisionError ? err.message : "error";
    return c.redirect("/dashboard?err=" + encodeURIComponent(msg));
  }
});

dashboardApp.post("/vaults/:id/rename", async (c: AuthedContext) => {
  const user = c.get("user");
  const vault = await getVaultById(c.env.ACCOUNTS_DB, c.req.param("id") ?? "");
  if (!vault || vault.user_id !== user.id) return c.text("not found", 404);
  const form = await c.req.formData();
  const newName = String(form.get("name") ?? "").trim().slice(0, 80);
  if (!newName) return c.redirect("/dashboard");
  await renameVault(c.env.ACCOUNTS_DB, vault.id, newName);
  return c.redirect("/dashboard");
});

dashboardApp.post("/vaults/:id/delete", async (c: AuthedContext) => {
  const user = c.get("user");
  const vault = await getVaultById(c.env.ACCOUNTS_DB, c.req.param("id") ?? "");
  if (!vault || vault.user_id !== user.id) return c.text("not found", 404);
  const form = await c.req.formData();
  if (String(form.get("confirm") ?? "") !== vault.slug) {
    return c.redirect("/dashboard?err=" + encodeURIComponent("confirmation did not match slug"));
  }
  const sub = await getActiveSubscription(c.env.ACCOUNTS_DB, user.id);
  const tier = (sub?.tier ?? "free") as TierId;

  // Order:
  //  1. Revoke any vault-scoped tokens for this slug. Otherwise the dashboard
  //     would keep showing them as "active" even though the vault row is
  //     gone — confusing for the user, and the next vault re-using the slug
  //     would inherit them.
  //  2. Hard-delete the D1 row. This stops `/v/<slug>/api/*` routing
  //     immediately, closing the window for concurrent writes.
  //  3. Wipe R2 via the DO. Reachable even after the D1 row is gone because
  //     the DO id is derived from `${userId}:${slug}`.
  const now = Math.floor(Date.now() / 1000);
  await c.env.ACCOUNTS_DB
    .prepare(
      "UPDATE tokens SET revoked_at = ? WHERE user_id = ? AND vault_slug = ? AND revoked_at IS NULL",
    )
    .bind(now, user.id, vault.slug)
    .run();

  await hardDeleteVault(c.env.ACCOUNTS_DB, vault.id);
  const wipe = await callVaultInternal(c.env, doIdName(user.id, vault.slug), {
    method: "POST",
    path: "/_internal/wipe-r2",
    tier,
  });
  if (!wipe.ok) {
    console.error(`delete-vault: R2 wipe returned ${wipe.status} for ${user.id}:${vault.slug}`);
  }
  return c.redirect("/dashboard?deleted=" + encodeURIComponent(vault.slug));
});

// ---- Tokens ----

dashboardApp.post("/tokens", async (c: AuthedContext) => {
  const user = c.get("user");
  const form = await c.req.formData();
  const name = String(form.get("name") ?? "").trim().slice(0, 60) || "default";
  const scopeRaw = String(form.get("scope") ?? "user");
  let vaultSlug: string | undefined;
  if (scopeRaw === "vault") {
    vaultSlug = String(form.get("vault_slug") ?? "").trim();
    if (!vaultSlug) {
      return c.redirect("/dashboard?err=" + encodeURIComponent("pick a vault for vault-scope"));
    }
  }
  const { token } = await issueToken(c.env.ACCOUNTS_DB, {
    userId: user.id,
    name,
    vaultSlug,
  });
  const cookie = await stashReveal(c.env, { kind: "token", token, name });
  appendSetCookie(c, cookie);
  return c.redirect("/dashboard");
});

dashboardApp.post("/tokens/:id/revoke", async (c: AuthedContext) => {
  const user = c.get("user");
  await revokeUserToken(c.env.ACCOUNTS_DB, user.id, c.req.param("id") ?? "");
  return c.redirect("/dashboard");
});

// ---- Rendering helpers ----

function layout(email: string, hostname: string, tier: TierId, body: string): string {
  return `<!doctype html>
<html><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="referrer" content="no-referrer" />
<title>${esc(hostname)} — Parachute</title>
<link rel="icon" type="image/svg+xml" href="/assets/favicon.svg" />
<link rel="stylesheet" href="/assets/styles.css" />
</head><body>
<nav class="topnav">
  <span class="brand">Parachute</span>
  <span class="host">${esc(hostname)}</span>
  <span class="pill pill-turquoise">${esc(tier)}</span>
  <span class="spacer"></span>
  <span class="email">${esc(email)}</span>
</nav>
<main class="container">
${body}
</main>
<footer>parachute.computer · <a href="https://parachute.computer">home</a></footer>
</body></html>`;
}

function onboardingPage(email: string, rootDomain: string, err: string | null, csrf: string): string {
  return `<!doctype html>
<html><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Pick your hostname — Parachute</title>
<link rel="icon" type="image/svg+xml" href="/assets/favicon.svg" />
<link rel="stylesheet" href="/assets/styles.css" />
</head><body>
<nav class="topnav">
  <span class="brand">Parachute</span>
  <span class="spacer"></span>
  <span class="email">${esc(email)}</span>
</nav>
<main class="onboard">
  <h1>Pick your hostname</h1>
  <p class="lead">Your vaults will live at <code>&lt;hostname&gt;.${esc(rootDomain)}/v/&lt;slug&gt;/…</code></p>
  ${err ? `<div class="banner banner-warn"><p>${esc(err)}</p></div>` : ""}
  <form method="POST" action="/onboarding/choose-hostname" id="onboard-form">
    ${csrfInput(csrf)}
    <div class="field-row">
      <div style="flex:1">
        <label>Subdomain</label>
        <input id="subdomain" name="subdomain" required autofocus pattern="[a-z0-9][a-z0-9-]{1,30}[a-z0-9]" placeholder="aaron" autocomplete="off" />
      </div>
      <span style="padding-bottom:0.55rem;color:var(--text-dim);font-family:var(--mono);font-size:13px">.${esc(rootDomain)}</span>
    </div>
    <div id="preview" class="hostname-preview"></div>
    <button class="btn btn-primary" type="submit" style="width:100%;justify-content:center;padding:0.7rem">Claim hostname</button>
  </form>
</main>
<script>
(function() {
  const input = document.getElementById("subdomain");
  const preview = document.getElementById("preview");
  const root = ${JSON.stringify(rootDomain)};
  let t = null;
  input.addEventListener("input", () => {
    const v = input.value.trim().toLowerCase();
    preview.className = "hostname-preview";
    if (!v) { preview.textContent = ""; return; }
    preview.textContent = "checking " + v + "." + root + "…";
    clearTimeout(t);
    t = setTimeout(async () => {
      try {
        const r = await fetch("/api/check-hostname?name=" + encodeURIComponent(v));
        const j = await r.json();
        if (j.available) {
          preview.textContent = v + "." + root;
          preview.classList.add("ok");
        } else {
          preview.textContent = (j.reason || "unavailable") + ": " + v + "." + root;
          preview.classList.add("err");
        }
      } catch { preview.textContent = ""; }
    }, 250);
  });
})();
</script>
</body></html>`;
}

function revealBanner(p: RevealPayload): string {
  if (p.kind === "welcome") {
    return `<div class="banner">
      <h2>Welcome — your parachute is ready</h2>
      <p>Your hostname: <code>${esc(p.hostname ?? "")}</code></p>
      <p><strong>Save this API token now — it will not be shown again:</strong></p>
      <div class="token-reveal">${esc(p.token)}</div>
      <p style="color:var(--text-dim);font-size:12.5px">Send as <code>Authorization: Bearer &lt;token&gt;</code>. This token works for every vault you own.</p>
    </div>`;
  }
  return `<div class="banner">
    <h2>New token: ${esc(p.name ?? "")}</h2>
    <p><strong>Save this token now — you won't see it again:</strong></p>
    <div class="token-reveal">${esc(p.token)}</div>
  </div>`;
}

function emptyVaultsState(): string {
  // Inline parachute glyph + Fraunces italic — first-impression for users
  // who haven't yet created anything past the default vault that onboarding
  // gives them. Shouldn't normally trigger (onboarding seeds /v/default),
  // so this is mostly a defensive render for an unusual state.
  return `<div class="empty" style="padding:3.5rem 1rem">
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="56" height="56" style="opacity:0.85;margin-bottom:0.8rem">
      <circle cx="32" cy="26" r="14" fill="#7AB09D"/>
      <path d="M18 30 Q12 44 10 54 M26 34 Q22 48 20 58 M32 36 Q32 50 32 60 M38 34 Q42 48 44 58 M46 30 Q52 44 54 54" stroke="#8CCFCE" stroke-width="2.5" stroke-linecap="round" fill="none"/>
    </svg>
    <p style="font-family:var(--display);font-style:italic;font-size:18px;color:var(--forest);margin:0 0 0.3rem">An empty parachute.</p>
    <p>No vaults yet — start with one.</p>
    <p style="margin-top:1rem"><a class="btn btn-primary" href="#new-vault">Create your first vault</a></p>
  </div>`;
}

function renameModal(vaultId: string, currentName: string, csrf: string): string {
  const id = `rename-${vaultId}`;
  return `<div class="modal" id="${esc(id)}">
    <div class="modal-body">
      <h3>Rename vault</h3>
      <form method="POST" action="/dashboard/vaults/${esc(vaultId)}/rename">
        ${csrfInput(csrf)}
        <div class="field">
          <label>New name</label>
          <input name="name" required maxlength="80" value="${esc(currentName)}" />
        </div>
        <div class="actions" style="display:flex;gap:0.5rem;justify-content:flex-end">
          <a class="btn btn-ghost" href="#">Cancel</a>
          <button class="btn btn-primary" type="submit">Save</button>
        </div>
      </form>
    </div>
  </div>`;
}

function deleteModal(vaultId: string, name: string, slug: string, csrf: string): string {
  const id = `delete-${vaultId}`;
  return `<div class="modal" id="${esc(id)}">
    <div class="modal-body">
      <h3 style="color:var(--err)">Delete ${esc(name)}</h3>
      <p style="color:var(--text-dim);font-size:13px">This deletes all notes, attachments, and the slug mapping for <code>/v/${esc(slug)}</code>. Vault-scoped tokens for this slug are revoked. Cannot be undone.</p>
      <form method="POST" action="/dashboard/vaults/${esc(vaultId)}/delete">
        ${csrfInput(csrf)}
        <div class="field">
          <label>Type the slug <code>${esc(slug)}</code> to confirm</label>
          <input name="confirm" required autocomplete="off" />
        </div>
        <div class="actions" style="display:flex;gap:0.5rem;justify-content:flex-end">
          <a class="btn btn-ghost" href="#">Cancel</a>
          <button class="btn btn-danger" type="submit">Delete vault</button>
        </div>
      </form>
    </div>
  </div>`;
}

function newVaultModal(csrf: string): string {
  return `<div class="modal" id="new-vault">
    <div class="modal-body">
      <h3>New vault</h3>
      <form method="POST" action="/dashboard/vaults">
        ${csrfInput(csrf)}
        <div class="field">
          <label>Name</label>
          <input name="name" required maxlength="80" placeholder="Work" />
        </div>
        <div class="field">
          <label>Slug (lives at /v/&lt;slug&gt;)</label>
          <input name="slug" required pattern="[a-z0-9][a-z0-9-]{0,39}" placeholder="work" />
        </div>
        <div class="actions" style="display:flex;gap:0.5rem;justify-content:flex-end">
          <a class="btn btn-ghost" href="#">Cancel</a>
          <button class="btn btn-primary" type="submit">Create</button>
        </div>
      </form>
    </div>
  </div>`;
}

function newTokenModal(vaultOpts: string, csrf: string): string {
  return `<div class="modal" id="new-token">
    <div class="modal-body">
      <h3>New API token</h3>
      <form method="POST" action="/dashboard/tokens">
        ${csrfInput(csrf)}
        <div class="field">
          <label>Name</label>
          <input name="name" required maxlength="60" placeholder="laptop" />
        </div>
        <div class="field">
          <label>Scope</label>
          <label style="display:block;font-size:14px;color:var(--text);margin:0.3rem 0">
            <input type="radio" name="scope" value="user" checked /> All my vaults (user-scope)
          </label>
          <label style="display:block;font-size:14px;color:var(--text);margin:0.3rem 0">
            <input type="radio" name="scope" value="vault" /> One vault only
          </label>
          <select name="vault_slug" style="background:var(--bg);border:1px solid var(--border-strong);color:var(--text);padding:0.5rem;border-radius:var(--radius-sm);width:100%;margin-top:0.4rem">
            ${vaultOpts}
          </select>
        </div>
        <div class="actions" style="display:flex;gap:0.5rem;justify-content:flex-end">
          <a class="btn btn-ghost" href="#">Cancel</a>
          <button class="btn btn-primary" type="submit">Create token</button>
        </div>
      </form>
    </div>
  </div>`;
}

function tokenRow(t: TokenRow, csrf: string): string {
  const scope = t.vault_slug
    ? `<span class="pill">/v/${esc(t.vault_slug)}</span>`
    : `<span class="pill pill-turquoise">all vaults</span>`;
  const created = dateStr(t.created_at);
  const lastUsed = t.last_used_at ? dateStr(t.last_used_at) : "—";
  const action = t.revoked_at
    ? `<span style="color:var(--text-muted);font-size:12px">revoked ${dateStr(t.revoked_at)}</span>`
    : `<form method="POST" action="/dashboard/tokens/${esc(t.id)}/revoke" style="display:inline">
         ${csrfInput(csrf)}
         <button class="btn btn-ghost" type="submit" onclick="return confirm('Revoke &quot;${esc(t.name)}&quot;?')">Revoke</button>
       </form>`;
  return `<tr>
    <td>${esc(t.name)}</td>
    <td>${scope}</td>
    <td>${created}</td>
    <td>${lastUsed}</td>
    <td>${action}</td>
  </tr>`;
}

function dateStr(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString().slice(0, 10);
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" :
    c === "<" ? "&lt;" :
    c === ">" ? "&gt;" :
    c === '"' ? "&quot;" : "&#39;");
}
