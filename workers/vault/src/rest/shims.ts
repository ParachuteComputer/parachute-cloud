/**
 * Cloud replacements for the handful of bun-vault-private modules the ported
 * REST handlers reference. Each collapses to a no-op / empty result because the
 * concern it served doesn't exist in the cloud runtime:
 *
 *  - token-store: tag-scoped tokens live in the vault DB on bun; cloud tokens
 *    live in the Identity Worker, so no tag can be "in use by a local token."
 *  - usage cache: bun walks the assets dir for a usage number; cloud has no
 *    such cache (R2 usage is metered directly — see caps.ts).
 *  - strict-bypass audit: bun logs to its daemon log; cloud logs to console.
 */
import type { ValidationWarning } from "@openparachute/core/src/schema-defaults.js";

/** No local token registry in cloud → nothing ever references a tag. */
export function findTokensReferencingTag(
  _db: unknown,
  _tag: string,
): { id: string; label: string }[] {
  return [];
}

/** No dir-walk usage cache in cloud. */
export function invalidateUsageCache(_vault: string): void {
  /* no-op */
}

/** Structured audit of a strict-schema-bypassed write. Cloud v1 has no
 * migrate-scope path, so this is only reached defensively. */
export function logStrictBypass(info: {
  actor: string | null;
  via: string | null;
  path: string | null;
  tags?: string[];
  violations: ValidationWarning[];
}): void {
  console.warn(
    `[strict-bypass] write bypassed strict schema: actor=${info.actor} via=${info.via} path=${info.path} violations=${info.violations.length}`,
  );
}
