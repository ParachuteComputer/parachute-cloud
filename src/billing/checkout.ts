// Stripe Checkout session creation.
//
// TODO(phase-3): implement Stripe checkout session for the Starter / Pro tiers
// defined in tiers.ts. Returns the redirect URL to send the prospective
// customer to from parachute.computer/cloud signup. Webhook on success goes to
// signup/handler.ts which kicks off provisioning.
//
// Stripe API version pin + product/price IDs land here.

export async function createCheckoutSession(): Promise<{ url: string }> {
  throw new Error("TODO(phase-3): implement Stripe checkout session creation");
}
