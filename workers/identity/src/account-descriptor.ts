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
import { type OAuthDeps, jsonResponse } from "./oauth-shared.ts";
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
    signup_path: "/signup",
    app_client_id: APP_CLIENT_ID,
    // Cloud v1: create yes; rename NO (the vault name is the immutable global
    // slug / DO address / URL); delete not yet (handleAccountVaultDelete is 501).
    capabilities: { vault_create: true, vault_rename: false, vault_delete: false },
    plans: planLadder(),
  };
  return jsonResponse(body, 200, CORS);
}
