/**
 * Parachute Cloud — top-level dispatcher Worker.
 *
 * Responsibilities:
 *   - Admin routes (`/signup`, `/dashboard/*`, `/billing/webhook`).
 *   - Hostname resolution: `<name>.parachute.computer` → vault_id → VaultDO.
 *   - Tier metadata forwarded to the DO via `X-Parachute-Tier`.
 *
 * Vault-scoped API token auth happens inside the DO (or will, once we
 * wire the vault-core token table on the DO side). The dispatcher only
 * checks ownership mapping from D1.
 */

import { Hono, type MiddlewareHandler } from "hono";
import type { Env } from "./env.js";
import { dashboardApp } from "./dashboard/index.js";
import { handleStripeWebhook } from "./billing/stripe.js";
import { provisionVault, ProvisionError } from "./signup/provision.js";
import { clerkMiddleware } from "./auth/clerk.js";
import type { SessionUser } from "./auth/clerk.js";
import type { UserRow } from "./db/users.js";
import { getVaultByHostname } from "./db/vaults.js";
import { getActiveSubscription } from "./db/subscriptions.js";
import { TIER_HEADER } from "./vault-do.js";
import { isTierId, tierOf, type TierId } from "./billing/tiers.js";

export { VaultDO } from "./vault-do.js";
export type { Env } from "./env.js";

type Vars = { session: SessionUser; user: UserRow };

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

// Admin routes are only valid on the root domain. Anything else with the
// same path on a vault subdomain is forwarded to the tenant's VaultDO.
const onRoot: MiddlewareHandler<{ Bindings: Env; Variables: Vars }> = async (c, next) => {
  const host = (c.req.header("Host") ?? "").toLowerCase();
  if (!isRootDomain(host, c.env.ROOT_DOMAIN)) {
    return handleVaultRequest(c.req.raw, c.env);
  }
  return next();
};

app.get("/health", onRoot, (c) => c.json({ ok: true, service: "parachute-cloud" }));

app.get("/", onRoot, (c) => c.redirect("/dashboard"));

// --- Admin API (root domain only) ---

app.post("/signup", onRoot, clerkMiddleware(), async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ name?: string; tier?: TierId }>().catch(() => null);
  if (!body?.name) return c.json({ error: "name required" }, 400);
  const requested = body.tier ?? user.tier;
  const tier: TierId = isTierId(requested) ? requested : "free";
  try {
    const result = await provisionVault(c.env, user, body.name, tier);
    return c.json(result, 201);
  } catch (err) {
    if (err instanceof ProvisionError) {
      return c.json({ error: err.message, code: err.code }, 400);
    }
    throw err;
  }
});

app.use("/dashboard/*", onRoot);
app.route("/dashboard", dashboardApp);

app.post("/billing/stripe/webhook", onRoot, (c) => handleStripeWebhook(c.req.raw, c.env));

// --- Vault subdomain routing ---
// Anything that lands on a non-root hostname is routed to its VaultDO.
app.all("*", async (c) => {
  return handleVaultRequest(c.req.raw, c.env);
});

async function handleVaultRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const host = (request.headers.get("Host") ?? url.host).toLowerCase();

  if (isRootDomain(host, env.ROOT_DOMAIN)) {
    return new Response("not found", { status: 404 });
  }

  const vault = await lookupVaultByHostname(env, host);
  if (!vault) return new Response(`no vault for ${host}`, { status: 404 });

  const sub = await getActiveSubscription(env.ACCOUNTS_DB, vault.owner_user_id);
  const tier = (sub?.tier ?? "free") as TierId;
  void tierOf(tier); // validate

  const doId = env.VAULT_DO.idFromName(vault.id);
  const stub = env.VAULT_DO.get(doId);
  const fwd = new Request(request, { headers: new Headers(request.headers) });
  fwd.headers.set(TIER_HEADER, tier);
  // Workers' DurableObjectStub#fetch returns CF's Response type; cast to the
  // global Response type expected by Hono's handler signature.
  return stub.fetch(fwd as unknown as import("@cloudflare/workers-types").Request) as unknown as Response;
}

async function lookupVaultByHostname(env: Env, hostname: string) {
  const cacheKey = `host:${hostname}`;
  try {
    const cached = await env.ACCOUNTS_CACHE.get(cacheKey, "json");
    if (cached) return cached as Awaited<ReturnType<typeof getVaultByHostname>>;
  } catch { /* cache optional */ }

  const row = await getVaultByHostname(env.ACCOUNTS_DB, hostname);
  if (row) {
    try { await env.ACCOUNTS_CACHE.put(cacheKey, JSON.stringify(row), { expirationTtl: 60 }); } catch {}
  }
  return row;
}

function isRootDomain(host: string, root: string): boolean {
  const h = host.toLowerCase().split(":")[0] ?? "";
  const r = root.toLowerCase();
  if (h === r || h === `www.${r}`) return true;
  // Treat bare `localhost` / `127.0.0.1` as root for local dev. A hostname like
  // `alice.localhost` should NOT match — that's how we route to a vault in dev.
  return h === "localhost" || h === "127.0.0.1";
}

export default app;
