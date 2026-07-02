/**
 * Tag-scope shim for the cloud runtime.
 *
 * The bun vault supports tag-scoped tokens (an allowlist of root tags a token
 * may see) via `src/tag-scope.ts`. Cloud v1 does NOT: hub/Identity-Worker JWTs
 * carry `permissions.scoped_tags = null` (unscoped), so every handler runs the
 * `allowed === null` passthrough branch. This module reproduces exactly that
 * branch's behavior so the ported handlers compile and behave identically to an
 * unscoped bun-vault request. If per-tenant tag-scoping ever lands in cloud,
 * this is the single seam to fill in (mirror `parachute-vault/src/tag-scope.ts`).
 */
import type { Note } from "@openparachute/core/src/types.js";

/**
 * Tag-scope context threaded through handlers. Both null = unscoped (cloud v1's
 * only shape); handlers fast-path on `allowed === null`.
 */
export type TagScopeCtx = { allowed: Set<string> | null; raw: string[] | null };

export const NO_TAG_SCOPE: TagScopeCtx = { allowed: null, raw: null };

/** Unscoped (raw === null) → every note visible. */
export function noteWithinTagScope(
  note: { tags?: string[] },
  allowed: Set<string> | null,
  raw: string[] | null,
): boolean {
  if (raw === null || allowed === null) return true;
  return (note.tags ?? []).some((t) => allowed.has(t));
}

/** Unscoped → passthrough. */
export function filterNotesByTagScope<T extends { tags?: string[] }>(
  notes: T[],
  allowed: Set<string> | null,
  raw: string[] | null,
): T[] {
  if (raw === null || allowed === null) return notes;
  return notes.filter((n) => (n.tags ?? []).some((t) => allowed.has(t)));
}

/** Unscoped → passthrough (hydrated-link neighbor filtering is a no-op). */
export function filterHydratedLinksByTagScope<T>(
  links: T[],
  allowed: Set<string> | null,
  raw: string[] | null,
): T[] {
  if (raw === null || allowed === null) return links;
  return links;
}

/** Only ever consulted under `if (tagScope.allowed)` — null-safe regardless. */
export function tagsWithinScope(
  tags: string[] | undefined,
  allowed: Set<string> | null,
  raw: string[] | null,
): boolean {
  if (raw === null || allowed === null) return true;
  return (tags ?? []).some((t) => allowed.has(t));
}

export function tagScopeForbidden(raw: string[]): Response {
  return Response.json(
    {
      error: "Forbidden",
      error_type: "tag_scope_violation",
      message: `write is outside this token's tag scope (${raw.join(", ")})`,
    },
    { status: 403 },
  );
}

/**
 * Wikilink-expansion visibility predicate. Unscoped → undefined (expand behaves
 * exactly as it does without a tag scope).
 */
export function buildExpandVisibility(
  allowed: Set<string> | null,
  raw: string[] | null,
): ((note: Note) => boolean) | undefined {
  if (raw === null || allowed === null) return undefined;
  return (note: Note) => (note.tags ?? []).some((t) => allowed.has(t));
}
