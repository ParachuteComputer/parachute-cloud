/**
 * Parachute Cloud dispatcher — v0.4 user-per-subdomain.
 *
 *   Root (`parachute.computer`)
 *     - /                   → /dashboard (if signed in) or landing
 *     - /dashboard/*        → admin UI
 *     - /onboarding/*       → first-login hostname picker
 *     - /signup             → JSON provisioning (CLI/MCP clients)
 *     - /billing/*          → Stripe webhook
 *     - /health             → structured health probe
 *     - /api/check-hostname → onboarding live availability check
 *
 *   User subdomain (`<user>.parachute.computer`)
 *     - /                   → user splash
 *     - /v/<slug>/api/*     → VaultDO public API (Bearer token required)
 *     - /v/<slug>/mcp       → VaultDO MCP endpoint (Bearer token required)
 *     - /v/<slug>/          → 404 (reserved for future vault-info page)
 *     - /health             → DO health (dispatched through)
 */

import { Hono, type MiddlewareHandler } from "hono";
import type { Env } from "./env.js";
import { dashboardApp } from "./dashboard/index.js";
import { handleStripeWebhook } from "./billing/stripe.js";
import {
  onboardUser,
  ProvisionError,
  hostnameAvailable,
  validateSubdomain,
} from "./signup/provision.js";
import { clerkMiddleware } from "./auth/clerk.js";
import type { SessionUser } from "./auth/clerk.js";
import type { UserRow } from "./db/users.js";
import { getUserByHostname } from "./db/users.js";
import { getVaultBySlug, doIdName } from "./db/vaults.js";
import { getActiveSubscription } from "./db/subscriptions.js";
import { TIER_HEADER, INTERNAL_SECRET_HEADER } from "./vault-do.js";
import { tierOf, type TierId } from "./billing/tiers.js";
import { verifyToken } from "./auth/tokens.js";
import { checkAndIncrement, rateLimitHeaders } from "./rate-limit.js";
import { assetsApp } from "./dashboard/assets.js";

export { VaultDO } from "./vault-do.js";
export type { Env } from "./env.js";

const VERSION = "0.4.0";

type Vars = { session: SessionUser; user: UserRow };

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

// Admin routes are only valid on the root domain. On any other host, the
// request is a vault request and goes through `handleVaultRequest`.
const onRoot: MiddlewareHandler<{ Bindings: Env; Variables: Vars }> = async (c, next) => {
  const host = (c.req.header("Host") ?? "").toLowerCase();
  if (!isRootDomain(host, c.env.ROOT_DOMAIN)) {
    return handleVaultRequest(c.req.raw, c.env);
  }
  return next();
};

app.get("/health", onRoot, async (c) => {
  const checks = { d1: await probeD1(c.env), r2: await probeR2(c.env) };
  const ok = checks.d1 && checks.r2;
  return c.json(
    {
      ok,
      service: "parachute-cloud",
      version: VERSION,
      timestamp: Date.now(),
      checks,
    },
    ok ? 200 : 503,
  );
});

app.get("/", onRoot, (c) => c.redirect("/dashboard"));

// Static brand assets (CSS, favicon) live here.
app.route("/assets", assetsApp);

// ---- Onboarding availability check ----

app.get("/api/check-hostname", onRoot, async (c) => {
  const name = c.req.query("name") ?? "";
  try {
    validateSubdomain(name);
  } catch (err) {
    const msg = err instanceof ProvisionError ? err.message : "invalid";
    return c.json({ available: false, reason: msg });
  }
  const available = await hostnameAvailable(c.env, name);
  return c.json({ available, hostname: `${name.toLowerCase()}.${c.env.ROOT_DOMAIN}` });
});

// ---- Admin API (root domain only) ----

app.post("/signup", onRoot, clerkMiddleware(), async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ subdomain?: string }>().catch(() => null);
  if (!body?.subdomain) return c.json({ error: "subdomain required" }, 400);
  try {
    const result = await onboardUser(c.env, user, body.subdomain);
    return c.json(
      {
        hostname: result.hostname,
        vaultId: result.vaultId,
        vaultSlug: result.vaultSlug,
        vaultUrl: `https://${result.hostname}/v/${result.vaultSlug}`,
        mcpUrl: `https://${result.hostname}/v/${result.vaultSlug}/mcp`,
        apiToken: result.apiToken,
        note: "apiToken is shown once. Save it now — it cannot be retrieved later.",
      },
      201,
    );
  } catch (err) {
    if (err instanceof ProvisionError) {
      return c.json({ error: err.message, code: err.code }, 400);
    }
    throw err;
  }
});

app.use("/dashboard/*", onRoot);
app.use("/onboarding/*", onRoot);
app.route("/dashboard", dashboardApp);
app.route("/onboarding", dashboardApp);

app.post("/billing/stripe/webhook", onRoot, (c) => handleStripeWebhook(c.req.raw, c.env));

// --- Vault subdomain routing ---
app.all("*", async (c) => handleVaultRequest(c.req.raw, c.env));

async function handleVaultRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const host = ((request.headers.get("Host") ?? url.host).toLowerCase().split(":")[0]) ?? "";

  if (isRootDomain(host, env.ROOT_DOMAIN)) {
    return new Response("not found", { status: 404 });
  }

  const user = await lookupUserByHostname(env, host);
  if (!user) return new Response(`no user for ${host}`, { status: 404 });

  if (url.pathname === "/" || url.pathname === "") {
    return userSplash(host);
  }
  if (url.pathname === "/health") {
    return new Response(JSON.stringify({ ok: true, host }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const match = /^\/v\/([a-z0-9][a-z0-9-]{0,39})(\/.*)?$/.exec(url.pathname);
  if (!match) return new Response("not found", { status: 404 });
  const slug = match[1]!;
  const rest = match[2] ?? "/";

  const vault = await getVaultBySlug(env.ACCOUNTS_DB, user.id, slug);
  if (!vault) return new Response(`no vault /v/${slug}`, { status: 404 });

  if (rest !== "/mcp" && !rest.startsWith("/api/")) {
    return new Response("not found", { status: 404 });
  }

  // Token auth — `Authorization: Bearer pvt_...`.
  const auth = request.headers.get("Authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  const verified = await verifyToken(env.ACCOUNTS_DB, bearer, slug);
  if (!verified || verified.userId !== user.id) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const sub = await getActiveSubscription(env.ACCOUNTS_DB, user.id);
  const tier = (sub?.tier ?? "free") as TierId;
  void tierOf(tier);

  if (rest.startsWith("/api/")) {
    const rl = await checkAndIncrement(env, `${user.id}:${slug}`, tier);
    if (!rl.allowed) {
      return new Response(
        JSON.stringify({
          error: "rate_limited",
          limit: rl.limit,
          retryAfter: rl.retryAfter,
          tier,
        }),
        {
          status: 429,
          headers: { "Content-Type": "application/json", ...rateLimitHeaders(rl) },
        },
      );
    }
  }

  // Drop the /v/<slug> prefix before forwarding — the DO only sees the
  // vault-local path.
  const fwdUrl = new URL(url);
  fwdUrl.pathname = rest;

  const doId = env.VAULT_DO.idFromName(doIdName(user.id, slug));
  const stub = env.VAULT_DO.get(doId);
  const headers = new Headers(request.headers);
  headers.delete(INTERNAL_SECRET_HEADER);
  const init: RequestInit = {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
  };
  // Streaming request bodies through Request require `duplex: "half"` on CF.
  if (init.body) {
    (init as unknown as { duplex?: string }).duplex = "half";
  }
  const fwd = new Request(fwdUrl.toString(), init);
  fwd.headers.set(TIER_HEADER, tier);
  return stub.fetch(
    fwd as unknown as import("@cloudflare/workers-types").Request,
  ) as unknown as Response;
}

function userSplash(host: string): Response {
  const body = `<!doctype html><html><head><meta charset="utf-8"><title>${host}</title>
<style>
  body{background:#0f1715;color:#E8E5E1;font:14px/1.5 system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:1rem}
  a{color:#8CCFCE;text-decoration:none}
  h1{font-family:"Fraunces",Georgia,serif;font-style:italic;font-weight:500;color:#7AB09D;margin:0 0 0.5rem;font-size:28px;letter-spacing:-0.015em}
  code{background:#192823;padding:2px 6px;border-radius:4px;font-family:"JetBrains Mono",ui-monospace,monospace;font-size:12.5px}
</style>
</head><body><div><h1>${host}</h1><p style="color:#A09B95">A Parachute. Vaults live at <code>/v/&lt;slug&gt;/…</code></p><p style="color:#7a7570;font-size:12px;margin-top:2rem">Admin at <a href="https://parachute.computer/dashboard">parachute.computer</a></p></div></body></html>`;
  return new Response(body, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

async function lookupUserByHostname(env: Env, hostname: string): Promise<UserRow | null> {
  const cacheKey = `host:${hostname}`;
  try {
    const cached = await env.ACCOUNTS_CACHE.get(cacheKey, "json");
    if (cached) return cached as UserRow;
  } catch { /* cache optional */ }

  const row = await getUserByHostname(env.ACCOUNTS_DB, hostname);
  if (row) {
    try { await env.ACCOUNTS_CACHE.put(cacheKey, JSON.stringify(row), { expirationTtl: 60 }); } catch {}
  }
  return row;
}

function isRootDomain(host: string, root: string): boolean {
  const h = host.toLowerCase().split(":")[0] ?? "";
  const r = root.toLowerCase();
  if (h === r || h === `www.${r}`) return true;
  // Bare localhost / 127.0.0.1 are root for dev. `<anything>.localhost`
  // routes through the vault path so subdomains can be exercised locally.
  return h === "localhost" || h === "127.0.0.1";
}

async function probeD1(env: Env): Promise<boolean> {
  try {
    const r = await env.ACCOUNTS_DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
    return r?.ok === 1;
  } catch {
    return false;
  }
}

async function probeR2(env: Env): Promise<boolean> {
  try {
    await env.ATTACHMENTS.head("__health_probe__");
    return true;
  } catch {
    return false;
  }
}

export default app;
