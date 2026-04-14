/**
 * User dashboard — minimal HTML, rendered server-side from the Worker.
 *
 * TODO (scaffold only). Routes served under `parachute.computer/dashboard`:
 *
 *   GET  /dashboard              → list user's vaults, current tier, usage bar
 *   POST /dashboard/vaults       → create a new vault (calls signup/provision)
 *   POST /dashboard/tokens       → mint a scoped API token for a vault
 *                                  (delegates to the VaultDO's existing token table)
 *   POST /dashboard/tokens/:id/revoke
 *   POST /dashboard/billing      → redirects to Stripe Billing Portal
 *
 * Auth: Clerk session required (src/auth/clerk.ts). Render with Hono's JSX.
 * Keep it plain HTML — no SPA. This is an admin surface, not the product.
 */

export {};
