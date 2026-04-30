/**
 * Stripe SDK factory wired for the Workers runtime.
 *
 * Two Workers-specific bits:
 *   1. `httpClient: Stripe.createFetchHttpClient()` so Stripe doesn't try
 *      to reach for `node:http`.
 *   2. The webhook verifier path uses `Stripe.createSubtleCryptoProvider()`
 *      because Workers don't expose `node:crypto` synchronously even with
 *      `nodejs_compat`. We hand the provider to `webhooks.constructEventAsync`
 *      from the webhook handler, not here — but exporting it from one place
 *      keeps the Workers-compat shape co-located.
 *
 * `apiVersion` is pinned to `2026-04-22.dahlia` (the SDK's `LatestApiVersion`
 * in stripe@22). Pinning means a future minor SDK bump won't silently move
 * us onto a newer wire shape — when we want a newer API version, the bump
 * is deliberate and the diff is small. Revisit at the next Stripe major.
 */

import Stripe from "stripe";

// `as const` pins the literal so a typo is a compile error. v22 dropped
// `Stripe.LatestApiVersion` from the namespace export (it lived there in
// v17) but `StripeConfig.apiVersion` accepts the literal directly.
const STRIPE_API_VERSION = "2026-04-22.dahlia" as const;

export function makeStripe(secretKey: string): Stripe {
  return new Stripe(secretKey, {
    apiVersion: STRIPE_API_VERSION,
    httpClient: Stripe.createFetchHttpClient(),
  });
}

/**
 * Concrete CryptoProvider instance type. v22's namespace exports
 * `CryptoProvider` only as the *constructor* (`static CryptoProvider`),
 * not as a type alias — so we derive the instance type with `InstanceType`.
 */
export type StripeCryptoProvider = InstanceType<typeof Stripe.CryptoProvider>;

export function makeSubtleCryptoProvider(): StripeCryptoProvider {
  return Stripe.createSubtleCryptoProvider();
}
