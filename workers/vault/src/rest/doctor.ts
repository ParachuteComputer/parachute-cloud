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
  // Keep the query contract identical to vault routes.ts (vault#759).
  const q = new URL(req.url).searchParams;
  if (q.has("deep") && !["true", "false"].includes(q.get("deep")!)) return json({ error: "deep must be true or false" }, 400);
  const deep = q.get("deep") === "true";
  if (deep && tagScope.allowed !== null) return json({ error: "deep history audit requires an unrestricted session" }, 403);
  const after = q.get("history_after") ?? undefined;
  const maxBlobs = q.has("history_max_blobs") ? Number(q.get("history_max_blobs")) : undefined;
  const budgetMs = q.has("history_budget_ms") ? Number(q.get("history_budget_ms")) : undefined;
  if ((after !== undefined && !/^[a-f0-9]{64}$/.test(after)) ||
      (maxBlobs !== undefined && (!Number.isInteger(maxBlobs) || maxBlobs < 1 || maxBlobs > 500)) ||
      (budgetMs !== undefined && (!Number.isInteger(budgetMs) || budgetMs < 1 || budgetMs > 1000))) return json({ error: "invalid history audit bounds or cursor" }, 400);
  const report = await store.doctor({ allowedTags: tagScope.allowed, deep, history_after: after, history_max_blobs: maxBlobs, history_budget_ms: budgetMs });
  return json(report);
}
