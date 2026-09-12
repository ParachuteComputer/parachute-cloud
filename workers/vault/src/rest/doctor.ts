/**
 * Doctor — GET /api/doctor. Port of vault routes.ts:4287-4294 and the
 * method check in routing.ts:1052-1054 at 41d91be (cloud B4).
 * Read-tier via the dispatcher's generic GET gate, like /find-path.
 * Cloud refuses tag-scoped tokens, so no scope expansion is ported and
 * the caller always passes NO_TAG_SCOPE. The scan is inherited from core.
 */
import type { Store } from "@openparachute/core/src/types.js";
import { json, type TagScopeCtx, NO_TAG_SCOPE } from "./parse.js";

export async function handleDoctor(
  req: Request,
  store: Store,
  tagScope: TagScopeCtx = NO_TAG_SCOPE,
): Promise<Response> {
  if (req.method !== "GET") return json({ error: "Method not allowed", error_type: "method_not_allowed" }, 405);
  const report = await store.doctor({ allowedTags: tagScope.allowed });
  return json(report);
}
