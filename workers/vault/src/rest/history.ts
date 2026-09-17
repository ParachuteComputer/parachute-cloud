import type { Store } from "@openparachute/core/src/types.js";
import { BodyTooLargeError, readCappedBody } from "../restore.js";
import { json } from "./parse.js";

const MAX_JSON_BODY_BYTES = 10 * 1024 * 1024;

/** Bounded history request parsing, including chunked requests without a length. */
export async function historyBody(req: Request, allowEmpty = false): Promise<Record<string, unknown> | Response> {
  try {
    if (Number(req.headers.get("content-length")) > MAX_JSON_BODY_BYTES) throw new BodyTooLargeError();
    const raw = new TextDecoder().decode(await readCappedBody(req, MAX_JSON_BODY_BYTES));
    const parsed = allowEmpty && !raw.trim() ? {} : JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("object required");
    return parsed;
  } catch (error) {
    if (error instanceof BodyTooLargeError) return json({ error: "Request body too large", error_type: "payload_too_large", limit: MAX_JSON_BODY_BYTES }, 413);
    return json({ error: "Invalid JSON body", error_type: "invalid_request" }, 400);
  }
}

/** Shared compaction engine; authentication remains at the DO dispatch boundary. */
export async function handleHistoryCompact(req: Request, store: Store): Promise<Response> {
  const body = await historyBody(req, true);
  if (body instanceof Response) return body;
  if ((body.note_id !== undefined && (typeof body.note_id !== "string" || !body.note_id)) ||
    [body.budget_ms, body.max_notes].some(v => v !== undefined && (typeof v !== "number" || !Number.isInteger(v) || v < 1))) {
    return json({ error: "Invalid compaction request", error_type: "invalid_request" }, 400);
  }
  try {
    // A request cannot monopolize the hosted isolate. Unlike the operator's
    // self-hosted batch endpoint, omitted bounds retain bounded defaults here.
    return json(store.compactHistory({ noteId: body.note_id as string | undefined,
      budgetMs: Math.min(body.budget_ms as number | undefined ?? 250, 250),
      maxNotes: Math.min(body.max_notes as number | undefined ?? 50, 50) }));
  } catch (error) {
    return json({ error: "Compaction failed", error_type: "compaction_failed", message: error instanceof Error ? error.message : String(error) }, 500);
  }
}
