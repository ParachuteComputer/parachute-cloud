/**
 * `GET /.well-known/parachute-account` — the cloud door's self-description (C4,
 * Parachute App campaign #116). Public, wildcard-CORS, no auth. A native app
 * fetches this to learn where to sign up, where the account API lives, which
 * first-party client to use, what the door can do, and its plan ladder — WITHOUT
 * hardcoding any of it. The shared shape + conformance helper live in
 * `@openparachute/door-contract` (`ParachuteAccountDescriptor` /
 * `checkAccountDescriptor`); the self-host hub serves its own twin (advertising
 * `/account/setup`, hub#748) in a follow-up.
 */
import type { AccountPlanSummary, ParachuteAccountDescriptor } from "@openparachute/door-contract";
import { type OAuthDeps, jsonResponse, vaultInstanceUrl } from "./oauth-shared.ts";
import { PAID_TIERS, PLAN_SPECS, TIER_PRICE_LABEL } from "./plans.ts";

/**
 * The reserved first-party client id a native app uses against the cloud door.
 * C5 seeds the pre-approved, pinned-redirect client under this id; the descriptor
 * advertises it here so the app never hardcodes.
 */
export const APP_CLIENT_ID = "parachute-app";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
};

/**
 * The plan ladder the descriptor advertises — `id`/`name`/`vaults` straight from
 * `PLAN_SPECS`, the headline monthly rate parsed from `TIER_PRICE_LABEL`
 * ("$3/mo" → 3) so the single source of pricing truth stays in `plans.ts`.
 */
function planLadder(): AccountPlanSummary[] {
  return PAID_TIERS.map((tier) => ({
    id: PLAN_SPECS[tier].id,
    name: PLAN_SPECS[tier].label,
    vaults: PLAN_SPECS[tier].vault_count,
    price_month: Number.parseInt(TIER_PRICE_LABEL[tier].replace(/[^0-9]/g, ""), 10),
  }));
}

export function accountDescriptor(deps: OAuthDeps): Response {
  const iss = deps.issuer;
  const body: ParachuteAccountDescriptor = {
    issuer: iss,
    door: "cloud",
    account_endpoint: `${iss}/account`,
    // `/login` is the ceremony page that carries magic-link + password + `next`
    // support; the app never hops there for magic_link (it posts /auth/magic
    // in-app), but the field must be honest for any client that does.
    auth: { methods: ["magic_link"], signin_path: "/login" },
    signup_path: "/signup",
    // `app_client_id` is deliberately NOT advertised here (hub-parity P3,
    // Q-approved C4-C5 §7.6): the hosted flow never OAuths its home door. The
    // APP_CLIENT_ID constant stays exported below — the C5 seeded client and
    // any cross-origin native flow still use it; only the advertisement goes.
    // Cloud v1: create yes; rename NO (the vault name is the immutable global
    // slug / DO address / URL); delete not yet (handleAccountVaultDelete is 501).
    capabilities: { vault_create: true, vault_rename: false, vault_delete: false },
    plans: planLadder(),
    // A `{name}`-placeholder template the app substitutes to preview a vault's
    // address pre-creation. Derived from the SAME vaultInstanceUrl the real URLs
    // come from (path form in prod, subdomain otherwise), so the two never
    // disagree — `{name}` isn't URL-encoded there, so it survives as a placeholder.
    vault_url_template: vaultInstanceUrl("{name}", deps),
  };
  return jsonResponse(body, 200, CORS);
}
