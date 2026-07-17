/**
 * Embedding off-switch resolution (semantic search MVP, C2). Mirrors
 * self-host's `src/embedding/select.ts` off-switch semantics exactly — only
 * the literal string `"false"` (case-insensitive, trimmed) disables;
 * unset/anything else is enabled. Cloud additionally STATES the var
 * explicitly in both `wrangler.toml` `[vars]` blocks (see `env.ts`'s
 * `EMBEDDINGS_ENABLED` doc) rather than relying on the unset-means-on
 * default, but the resolution rule is identical so an operator's mental
 * model transfers across doors.
 */
export function embeddingsExplicitlyDisabled(env: { EMBEDDINGS_ENABLED?: string }): boolean {
  return env.EMBEDDINGS_ENABLED?.trim().toLowerCase() === "false";
}
