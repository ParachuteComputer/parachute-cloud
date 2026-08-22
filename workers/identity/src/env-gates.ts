/**
 * Environments allowed to expose `__test/*` routes, the magic-link echo
 * header, and mock billing.
 *
 * ALLOWLIST, not denylist. Unset, misspelled (`Production`), whitespace-padded
 * (`production `), or unknown `ENVIRONMENT` fails closed — a locked staging
 * box is a visible annoyance; an open production box is not.
 *
 * Membership:
 *   - `staging`     — wrangler `[env.staging]`
 *   - `development` — local wrangler-dev slot named in cloud#223
 *   - `test`        — vitest-pool pin (`vitest.config.ts`); without it the
 *                     identity suite's `__test/*` + echo-header tests 404
 *
 * Production-only behavior (`cloudFrontDoorRedirect`) is the inverse and is
 * NOT routed through this helper.
 */
export const DEV_EXPOSURE_ENVIRONMENTS = ["staging", "development", "test"] as const;

export function isDevExposureEnv(environment: string | undefined): boolean {
  return (
    environment === "staging" ||
    environment === "development" ||
    environment === "test"
  );
}
