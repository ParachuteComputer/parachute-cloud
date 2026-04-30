// POST /signup/webhook — entry point invoked by the Stripe webhook router on
// checkout.session.completed.
//
// TODO(phase-2): parse the Stripe event, persist the new tenant row, kick
// orchestrate.ts to provision the VM. Returns 200 immediately; orchestration
// runs out-of-band so a slow Fly API call doesn't block the webhook.
//
// Hand-off envelope (Stripe → orchestrator):
//   tenant_id, plan, chosen_subdomain (or deferred), customer_email.

export async function handleSignupWebhook(_req: Request): Promise<Response> {
  throw new Error("TODO(phase-2): implement signup webhook handler");
}
