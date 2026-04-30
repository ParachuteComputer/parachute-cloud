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
 * `apiVersion` is pinned so a future SDK bump doesn't silently change
 * the wire shape; revisit when we touch this for Phase 3.
 */

import Stripe from "stripe";

const STRIPE_API_VERSION: Stripe.LatestApiVersion = "2025-02-24.acacia";

export function makeStripe(secretKey: string): Stripe {
  return new Stripe(secretKey, {
    apiVersion: STRIPE_API_VERSION,
    httpClient: Stripe.createFetchHttpClient(),
  });
}

export function makeSubtleCryptoProvider(): Stripe.CryptoProvider {
  return Stripe.createSubtleCryptoProvider();
}
