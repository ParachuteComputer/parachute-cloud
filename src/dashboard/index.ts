// Operator dashboard — internal-facing.
//
// TODO(phase-2/3): minimal Bun.serve HTML surface for Aaron + future
// operators. Per-VM status (provider, handle, region, plan, last-seen),
// link out to the user's Stripe customer portal, manual destroy + re-provision
// buttons. Never shows user data — this is just metadata.
//
// Authn: simple shared secret behind an `Authorization: Bearer` header for
// v1; harden when there's more than one operator.

export async function handleDashboardRequest(_req: Request): Promise<Response> {
  throw new Error("TODO(phase-2/3): implement operator dashboard");
}
