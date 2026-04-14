/**
 * Stripe integration — checkout, billing portal, webhook handler.
 *
 * TODO (scaffold only):
 *   - createCheckoutSession(userId, tierId) → Stripe Checkout URL.
 *   - createPortalSession(customerId) → Stripe Billing Portal URL.
 *   - handleWebhook(request, env) →
 *       verify signature (STRIPE_WEBHOOK_SECRET),
 *       on `customer.subscription.*` events, update the `subscriptions` row
 *       in D1 (tier, status, current_period_end).
 *
 * Stripe SDK works on Workers via the `stripe` package with `fetch` global.
 * Use `httpClient: Stripe.createFetchHttpClient()` when instantiating.
 */

export {};
