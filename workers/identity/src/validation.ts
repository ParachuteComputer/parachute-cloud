/**
 * Shared input validation for the console + auth surfaces. Kept in its own module
 * so both `console.ts` and `auth-handlers.ts` use the same rules without importing
 * each other.
 */

// Deliberately permissive, structural email check (a real MX/verification step is
// the magic-link flow itself). Rejects the obvious non-addresses.
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const PASSWORD_MIN = 8;

/** Trim + lowercase — the canonical form for lookups + magic-link keys. */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}
