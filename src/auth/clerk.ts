/**
 * Clerk session verification.
 *
 * TODO (scaffold only):
 *   - verifySession(request, env) → { clerkUserId, email } | null
 *     Uses @clerk/backend's `verifyToken` with CLERK_SECRET_KEY.
 *   - resolveUser(clerkUserId, env) → internal user row from D1
 *     (creates one on first sight; idempotent).
 *
 * Clerk session gates admin actions (dashboard, signup, billing).
 * Vault MCP/API access uses scoped tokens from vault-core, not Clerk sessions.
 */

export {};
