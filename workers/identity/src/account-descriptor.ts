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
import { type OAuthDeps, frontDoorOrigin, jsonResponse, vaultAdvertisedUrl } from "./oauth-shared.ts";
import { PAID_TIERS, PLAN_SPECS, TIER_PRICE_MONTHLY_USD, type TierIntervalAvailability, tierIntervals } from "./plans.ts";

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
 * The additive per-interval extension the descriptor publishes on top of the
 * shared `AccountPlanSummary` shape (door-contract) — F1/F5: cloud already has
 * this truth (`plans.ts` `TIER_INTERVAL_AMOUNTS`, via `tierIntervals`), it just
 * needed publishing so the app can render an interval selector (monthly/
 * quarterly/yearly) showing only the cycles a tier actually has, instead of
 * assuming every tier bills monthly (entry doesn't — Stripe's flat fee eats a
 * $1 monthly charge). `price_month` (the door-contract field) is UNCHANGED —
 * kept for back-compat so any existing reader of the old shape still works;
 * `intervals` is new and purely additive. A door-contract consumer that only
 * knows `AccountPlanSummary` sees exactly the fields it expects; one that
 * knows this shape gets the extra data too.
 */
export interface AccountPlanSummaryWithIntervals extends AccountPlanSummary {
  /** Per-cycle availability/price/label, keyed by the three billing cycles —
   *  {@link TierIntervalAvailability} for each. entry.monthly reads
   *  `{available:false}` (no monthly Price exists for entry). */
  intervals: {
    monthly: TierIntervalAvailability;
    quarterly: TierIntervalAvailability;
    yearly: TierIntervalAvailability;
  };
}

/**
 * The plan ladder the descriptor advertises — `id`/`name`/`vaults` straight
 * from `PLAN_SPECS`, `price_month` from the numeric `TIER_PRICE_MONTHLY_USD`
 * source (not a regex-parse of the `TIER_PRICE_LABEL` display string — the
 * plans.ts note: a future non-integer label like "$2.50/mo" would otherwise
 * corrupt to 250), and the new `intervals` breakdown from `tierIntervals` —
 * all three read the SAME `plans.ts` source of pricing truth.
 */
function planLadder(): AccountPlanSummaryWithIntervals[] {
  return PAID_TIERS.map((tier) => ({
    id: PLAN_SPECS[tier].id,
    name: PLAN_SPECS[tier].label,
    vaults: PLAN_SPECS[tier].vault_count,
    price_month: TIER_PRICE_MONTHLY_USD[tier],
    intervals: tierIntervals(tier),
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
    // The account-level MCP endpoint (Wave A PR3) — one connection across the
    // account's vaults (list-vaults / create-vault / query-notes). Advertised at
    // the FRONT DOOR origin (`my.` in prod, self-referential in staging), where
    // the endpoint actually lands, NOT `iss` (which stays `cloud.` through Phase
    // 4). Its RFC 9728 PRM sits at `<frontDoor>/.well-known/oauth-protected-
    // resource/account/mcp`.
    account_mcp_endpoint: `${frontDoorOrigin(deps)}/account/mcp`,
    plans: planLadder(),
    // A `{name}`-placeholder template the app substitutes to preview a vault's
    // address pre-creation. Derived from the SAME vaultAdvertisedUrl the real
    // console/account URLs come from (the PUBLIC origin — `my.` in prod, path
    // form in staging, subdomain otherwise), so the two never disagree —
    // `{name}` isn't URL-encoded there, so it survives as a placeholder.
    vault_url_template: vaultAdvertisedUrl("{name}", deps),
  };
  return jsonResponse(body, 200, CORS);
}
