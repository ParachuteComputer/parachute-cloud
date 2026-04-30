// Stripe webhook handler.
//
// TODO(phase-3): verify signature, route by event type:
//   - checkout.session.completed → trigger signup/handler.ts (provision a VM)
//   - customer.subscription.updated → tier change → resize / suspend VM
//   - customer.subscription.deleted → tear down VM (with grace period)
//   - invoice.payment_failed → suspend VM after retry window
//
// Idempotency by event id; durable storage in the per-tenant DB so a
// retried webhook can't double-provision.

export async function handleStripeWebhook(_req: Request): Promise<Response> {
  throw new Error("TODO(phase-3): implement Stripe webhook router");
}
