/**
 * `/api/records` and `/api/types` on the cloud door (door/0.9, T-430; SPEC §5.1, ROADMAP 0.9.1 "doors and names").
 *
 * The REST twin of the record door: the same request runs through the `/api/notes` (or `/api/tags`) handler, with
 * its words moved by the engine's own translator (`paramsIn` in, `resultOut` out, core/src/mcp-records.ts), so a
 * record on REST has exactly the shape it has on `query-records`: `body` for content, `fields` for metadata,
 * `records` for a batch, `record_id` for a pointer, and `tags` holding plain labels with `types` beside them.
 * Auth, scopes, caps, write gates and health counting are the `/api/notes` path's, unchanged: this is a rename at
 * the edge of the request, never a second implementation.
 *
 *   /api/records[/<id or path>[/<sub>]]   → /api/notes…   (list, get, create, patch, delete, versions, restore…)
 *   ?type=<name>                         the engine's query-records `type` (foldTypeFilter, in rest/notes.ts):
 *                                         a type and its subtypes; with ?tag, records carrying all of them
 *   ?include_body / ?include_fields      → ?include_content / ?include_metadata
 *   /api/types[/<name>]                  → /api/tags…     (writes need admin, as /api/tags)
 *
 * Every `/api/notes` response carries `Deprecation: true` and a `Link` to its `/api/records` successor (SPEC §5.1:
 * the alias is counted and stays through 0.9, gone at 1.0).
 *
 * The box (parachute-core) has not built `/api/records` yet; this follows the SPEC and should move into the engine
 * beside mcp-records.ts when core builds it, so both doors run one translator.
 */
import { paramsIn, resultOut } from "@openparachute/core/src/mcp-records.js";

const QUERY_RENAMES: Record<string, string> = {
  include_body: "include_content",
  include_fields: "include_metadata",
  body_offset: "content_offset",
  body_length: "content_length",
};

/** `/vault/<v>/api/records…` or `/vault/<v>/api/types…`: which door, and the `/api/notes…` path it runs as. */
export function recordsRoute(pathname: string): { kind: "records" | "types"; notesPath: string } | null {
  const m = /^(\/vault\/[^/]+\/api)\/(records|types)(\/.*)?$/.exec(pathname);
  if (!m) return null;
  const kind = m[2] as "records" | "types";
  return { kind, notesPath: `${m[1]}/${kind === "records" ? "notes" : "tags"}${m[3] ?? ""}` };
}

/** The record tool a REST call is the twin of (its parameter words and answer words). */
function toolFor(method: string): string {
  if (method === "POST") return "create-record";
  if (method === "PATCH" || method === "PUT") return "update-record";
  if (method === "DELETE") return "delete-record";
  return "query-records";
}

/**
 * Run a `/api/records` or `/api/types` request through `inner` (the DO's own fetch) as its `/api/notes` /
 * `/api/tags` twin, and answer in record words.
 */
/** The /api/notes requests that are /api/records twins (only these take `?type=`). Set here, read by handleNotes. */
export const RECORDS_REQUESTS = new WeakSet<Request>();
/**
 * A records body the translator refused (an old word beside its new one): the refusal, answered by handleNotes, so
 * after auth (an anonymous caller still gets 401 first) and before anything is written.
 */
export const RECORDS_REFUSALS = new WeakMap<Request, Response>();

export async function recordsDoor(request: Request, route: { kind: "records" | "types"; notesPath: string }, inner: (req: Request) => Promise<Response>): Promise<Response> {
  const url = new URL(request.url);
  const out = new URL(url);
  out.pathname = route.notesPath;
  if (route.kind === "records") {
    out.search = "";
    for (const [k, v] of url.searchParams) out.searchParams.append(QUERY_RENAMES[k] ?? k, v);
  }
  const tool = toolFor(request.method);
  let refusal: Response | null = null;
  const headers = new Headers(request.headers);
  let body: BodyInit | null = null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    // Any body that isn't plainly binary or multipart is read as JSON, as the /api/notes handler reads it whatever
    // the content-type says (curl -d sends application/x-www-form-urlencoded).
    const ct = (request.headers.get("content-type") ?? "").toLowerCase();
    if (route.kind === "records" && !/^(multipart\/|application\/octet-stream|audio\/|video\/|image\/)/.test(ct)) {
      const text = await request.text();
      if (text.trim()) {
        // Not JSON: it goes on as it came, and the handler answers it after auth, as /api/notes would. Words that
        // conflict (`body` beside `content`): refused, never written, but answered after auth too (RECORDS_REFUSALS).
        let parsed: unknown;
        let isJson = true;
        try {
          parsed = JSON.parse(text);
        } catch {
          isJson = false;
          body = text;
        }
        if (isJson) {
          headers.set("content-type", "application/json");
          try {
            body = JSON.stringify(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? paramsIn(tool, parsed as Record<string, unknown>) : parsed);
          } catch (err) {
            const e = err as { message?: string; error_type?: string; field?: string; hint?: string };
            refusal = Response.json({ error: e.message ?? "invalid parameters", error_type: e.error_type ?? "invalid_query", field: e.field, hint: e.hint }, { status: 400 });
            body = "{}";
          }
        }
        headers.delete("content-length");
      }
    } else {
      body = await request.arrayBuffer();
    }
  }
  const twin = new Request(out.toString(), { method: request.method, headers, body });
  if (route.kind === "records") RECORDS_REQUESTS.add(twin);
  if (refusal) RECORDS_REFUSALS.set(twin, refusal);
  const res = await inner(twin);
  if (route.kind === "types") return res;
  if (!(res.headers.get("content-type") ?? "").includes("application/json")) return res;
  const answer = resultOut(tool, await res.json());
  const h = new Headers(res.headers);
  h.delete("content-length");
  return new Response(JSON.stringify(answer), { status: res.status, headers: h });
}

/** `/api/notes…` answers say they are leaving (SPEC §5.1), naming the route to use. */
export function withNotesDeprecation(pathname: string, res: Response): Response {
  const m = /^(\/vault\/[^/]+\/api)\/notes(\/.*)?$/.exec(pathname);
  if (!m || res.status === 101 || res.webSocket) return res;
  const h = new Headers(res.headers);
  h.set("Deprecation", "true");
  h.append("Link", `<${m[1]}/records${m[2] ?? ""}>; rel="successor-version"`);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}
