/**
 * Pure query-param / body parsing for the REST surface — ported verbatim from
 * parachute-vault/src/routes.ts (the wire contract lives in the parser, so we
 * transcribe it rather than reinvent it; the conformance suite pins any drift).
 * Everything here is a pure URL→object function with no runtime-specific deps,
 * so it is identical to the bun vault.
 */
import type { Store, Note, QueryOpts } from "@openparachute/core/src/types.js";
import {
  TAG_EXPAND_MODES,
  type TagExpandMode,
} from "@openparachute/core/src/tag-hierarchy.js";
import {
  parseContentRange,
  contentRangeRequiresContent,
  type ContentRange,
} from "@openparachute/core/src/content-range.js";
import {
  DEFAULT_EXPAND_DEPTH,
  MAX_EXPAND_DEPTH,
  type ExpandContext,
  type ExpandMode,
} from "@openparachute/core/src/expand.js";
import type { QueryWarning } from "@openparachute/core/src/query-warnings.js";
import { type TagScopeCtx, NO_TAG_SCOPE, buildExpandVisibility } from "./tag-scope.js";

export { type TagScopeCtx, NO_TAG_SCOPE } from "./tag-scope.js";

/**
 * Write-attribution context (vault#298) — the principal (`actor`) and interface
 * (`via`) threaded from the authenticated request into store writes.
 */
export type WriteCtx = {
  actor: string | null;
  via: string | null;
  bypassStrict?: boolean;
};

export const NO_WRITE_CTX: WriteCtx = { actor: null, via: null };

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

/**
 * `json(...)` plus the `X-Parachute-Warnings` response header (ported from
 * routes.ts:jsonWithWarnings, vault#550/contracts-brief C1.3) —
 * `encodeURIComponent(JSON.stringify(warnings))`, set only when `warnings` is
 * non-empty. Percent-encoded for the same reason bun's does: HTTP header
 * VALUES are Latin1/ASCII-only, while a warning `message` may not be 7-bit
 * clean. Decode with `decodeURIComponent` then `JSON.parse`. Callers that want
 * warnings INLINE in an envelope body should also spread them in before
 * calling this (mirrors the bun cursor-envelope call sites).
 */
export function jsonWithWarnings(data: unknown, warnings: QueryWarning[], status = 200): Response {
  const res = json(data, status);
  if (warnings.length > 0) {
    res.headers.set("X-Parachute-Warnings", encodeURIComponent(JSON.stringify(warnings)));
  }
  return res;
}

/**
 * Cursor-mode response. Keeps the bun body shape (`{ notes, next_cursor }` — so
 * REST clients work unchanged) AND mirrors the watermark into an `X-Next-Cursor`
 * header (design §5 discriminator list). The header is present only when the
 * watermark is non-null. `X-Next-Cursor` is a CLOUD-ONLY additive convenience —
 * bun never emits it (the body's `next_cursor` is the cross-door contract,
 * contracts-brief item 3/C1.3) — kept for existing header-reading clients.
 */
export function cursorJson(notes: unknown[], nextCursor: string | null): Response {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (nextCursor !== null) headers["X-Next-Cursor"] = nextCursor;
  return new Response(JSON.stringify({ notes, next_cursor: nextCursor }), { status: 200, headers });
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export function parseBool(val: string | null, defaultVal: boolean): boolean {
  if (val === null) return defaultVal;
  return val === "true" || val === "1";
}

export function parseBoolOrUndef(val: string | null): boolean | undefined {
  if (val === null) return undefined;
  if (val === "true" || val === "1") return true;
  if (val === "false" || val === "0") return false;
  return undefined;
}

export function parseQuery(url: URL, key: string): string | null {
  return url.searchParams.get(key);
}

export function parseLinkCountDirection(url: URL): "both" | "outbound" | "inbound" {
  const v = url.searchParams.get("link_count_direction");
  if (v === "outbound" || v === "inbound") return v;
  return "both";
}

export function parseQueryList(url: URL, key: string): string[] | undefined {
  const val = url.searchParams.get(key);
  return val ? val.split(",") : undefined;
}

export function parseContentRangeQuery(
  url: URL,
  includeContent: boolean,
): { range: ContentRange | null; error?: Response } {
  try {
    const range = parseContentRange(
      parseQuery(url, "content_offset") ?? undefined,
      parseQuery(url, "content_length") ?? undefined,
    );
    if (range && !includeContent) throw contentRangeRequiresContent();
    return { range };
  } catch (e: any) {
    if (e && e.name === "QueryError") {
      return {
        range: null,
        error: json(
          { error: e.message, code: e.code ?? "INVALID_QUERY", error_type: e.error_type ?? "invalid_query" },
          400,
        ),
      };
    }
    throw e;
  }
}

export function parseExtensionFilter(url: URL): string | string[] | undefined {
  const all = url.searchParams.getAll("extension");
  if (all.length === 0) return undefined;
  const flat = all.flatMap((v) => v.split(",")).map((s) => s.trim()).filter((s) => s.length > 0);
  if (flat.length === 0) return undefined;
  if (flat.length === 1) return flat[0]!;
  return flat;
}

export function parseInt10(val: string | null): number | undefined {
  if (!val) return undefined;
  const n = parseInt(val, 10);
  return isNaN(n) ? undefined : n;
}

/**
 * Bracket-style metadata filters (`?meta[field][op]=value`). Ported from
 * routes.ts:parseMetaBrackets.
 */
export function parseMetaBrackets(url: URL): {
  metadata?: Record<string, unknown>;
  dateFilter?: { field: string; from?: string; to?: string };
  error?: Response;
} {
  const REAL_DATE_COLUMNS = new Set(["created_at", "updated_at"]);
  const ARRAY_OPS = new Set(["in", "not_in"]);
  const META_RE = /^meta\[([^\]]+)\](?:\[([^\]]+)\](\[\])?)?$/;

  const metadata: Record<string, unknown> = {};
  const shorthandFields = new Set<string>();
  const opBucketsByField = new Map<string, Map<string, string[]>>();
  const opObjectByField = new Map<string, Record<string, unknown>>();

  let dateField: "created_at" | "updated_at" | null = null;
  let dateFrom: string | undefined;
  let dateTo: string | undefined;

  function rejectMixedForms(field: string): Response {
    return json(
      {
        error: `bracket-meta filter: cannot mix shorthand and operator forms for the same field — \`meta[${field}]=…\` and \`meta[${field}][<op>]=…\` are mutually exclusive in one request. Pick one form.`,
        code: "INVALID_QUERY",
      },
      400,
    );
  }

  function getOpObject(field: string): Record<string, unknown> {
    let bucket = opObjectByField.get(field);
    if (!bucket) {
      bucket = {};
      opObjectByField.set(field, bucket);
    }
    return bucket;
  }

  for (const [key, value] of url.searchParams.entries()) {
    const m = META_RE.exec(key);
    if (!m) continue;
    const field = m[1]!;
    const op = m[2];
    const isArray = m[3] === "[]";

    if (REAL_DATE_COLUMNS.has(field)) {
      if (!op) {
        return {
          error: json(
            {
              error: `bracket-date filter on \`${field}\` requires an operator: meta[${field}][gte]=… (lower bound) or meta[${field}][lt]=… (upper bound, exclusive).`,
              code: "INVALID_QUERY",
            },
            400,
          ),
        };
      }
      if (op !== "gte" && op !== "lt") {
        return {
          error: json(
            {
              error: `bracket-date filter on \`${field}\` supports only \`gte\` (inclusive lower bound) and \`lt\` (exclusive upper bound). Got: \`${op}\`. The dateFilter contract is half-open by design.`,
              code: "INVALID_QUERY",
            },
            400,
          ),
        };
      }
      if (dateField !== null && dateField !== field) {
        return {
          error: json(
            {
              error: `bracket-date filter cannot span both \`created_at\` and \`updated_at\` in one request — issue two queries or use one column per request.`,
              code: "INVALID_QUERY",
            },
            400,
          ),
        };
      }
      dateField = field as "created_at" | "updated_at";
      if (op === "gte") dateFrom = value;
      else dateTo = value;
      continue;
    }

    if (!op) {
      if (opObjectByField.has(field) || opBucketsByField.has(field)) {
        return { error: rejectMixedForms(field) };
      }
      shorthandFields.add(field);
      metadata[field] = value;
      continue;
    }
    if (shorthandFields.has(field)) {
      return { error: rejectMixedForms(field) };
    }
    if (isArray && !ARRAY_OPS.has(op)) {
      return {
        error: json(
          {
            error: `bracket-meta filter: array form \`meta[${field}][${op}][]=…\` is only valid for \`in\` and \`not_in\`. \`${op}\` takes a single value — use \`meta[${field}][${op}]=value\` instead.`,
            code: "INVALID_OPERATOR_VALUE",
          },
          400,
        ),
      };
    }
    if (isArray) {
      let fieldBucket = opBucketsByField.get(field);
      if (!fieldBucket) {
        fieldBucket = new Map<string, string[]>();
        opBucketsByField.set(field, fieldBucket);
      }
      let values = fieldBucket.get(op);
      if (!values) {
        values = [];
        fieldBucket.set(op, values);
      }
      values.push(value);
      continue;
    }
    if (op === "in" || op === "not_in") {
      const arr = value.includes(",")
        ? value.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
        : [value];
      getOpObject(field)[op] = arr;
    } else if (op === "exists") {
      const bool = value === "true" ? true : value === "false" ? false : null;
      if (bool === null) {
        return {
          error: json(
            {
              error: `bracket-meta filter: \`exists\` on \`${field}\` requires "true" or "false", got "${value}"`,
              code: "INVALID_OPERATOR_VALUE",
            },
            400,
          ),
        };
      }
      getOpObject(field)[op] = bool;
    } else {
      getOpObject(field)[op] = value;
    }
  }

  for (const [field, opMap] of opBucketsByField) {
    for (const [op, values] of opMap) {
      getOpObject(field)[op] = values;
    }
  }
  for (const [field, opObj] of opObjectByField) {
    metadata[field] = opObj;
  }

  const result: {
    metadata?: Record<string, unknown>;
    dateFilter?: { field: string; from?: string; to?: string };
  } = {};
  if (Object.keys(metadata).length > 0) result.metadata = metadata;
  if (dateField) {
    result.dateFilter = { field: dateField };
    if (dateFrom !== undefined) result.dateFilter.from = dateFrom;
    if (dateTo !== undefined) result.dateFilter.to = dateTo;
  }
  return result;
}

/** `?metadata=<json>` alias. Ported from routes.ts:parseMetadataJsonAlias. */
export function parseMetadataJsonAlias(url: URL): {
  metadata?: Record<string, unknown>;
  error?: Response;
} {
  const raw = parseQuery(url, "metadata");
  if (raw === null) return {};

  const malformed = (detail: string): Response =>
    json(
      {
        error: `metadata query param must be a JSON object of the form {"field":{"op":value}} — ${detail}`,
        code: "INVALID_QUERY",
      },
      400,
    );

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { error: malformed(`failed to parse: ${e instanceof Error ? e.message : String(e)}`) };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    const got = Array.isArray(parsed) ? "array" : parsed === null ? "null" : typeof parsed;
    return { error: malformed(`got ${got}`) };
  }
  if (Object.keys(parsed).length === 0) return {};
  return { metadata: parsed as Record<string, unknown> };
}

/** `?expand=` tag-expansion axis. Ported from routes.ts:parseExpandParam. */
export function parseExpandParam(url: URL): { expand?: TagExpandMode; error?: Response } {
  const expandParam = parseQuery(url, "expand");
  if (expandParam === null || expandParam === "") return {};
  if (!(TAG_EXPAND_MODES as readonly string[]).includes(expandParam)) {
    return {
      error: json(
        {
          error: `invalid \`expand\` value "${expandParam}" — must be one of ${TAG_EXPAND_MODES.map((m) => `"${m}"`).join(", ")}. Omit for the default ("subtypes": parent_names descendants).`,
          code: "INVALID_QUERY",
          error_type: "invalid_query",
          field: "expand",
          got: expandParam,
          hint: `pass one of ${TAG_EXPAND_MODES.map((m) => `"${m}"`).join(", ")}, or omit for the default`,
        },
        400,
      ),
    };
  }
  return { expand: expandParam as TagExpandMode };
}

/** Shared structured-query parser. Ported from routes.ts:parseNotesQueryOpts. */
export function parseNotesQueryOpts(url: URL): {
  queryOpts?: QueryOpts;
  hasSearch: boolean;
  hasNear: boolean;
  hasCursor: boolean;
  error?: Response;
} {
  const hasSearch = parseQuery(url, "search") !== null && parseQuery(url, "search") !== "";
  const hasNear = parseQuery(url, "near[note_id]") !== null;
  const cursorParam = parseQuery(url, "cursor");
  const hasCursor = cursorParam !== null && cursorParam !== "";

  const tags = parseQueryList(url, "tag");
  const bracket = parseMetaBrackets(url);
  if (bracket.error) return { hasSearch, hasNear, hasCursor, error: bracket.error };
  const metadataAlias = parseMetadataJsonAlias(url);
  if (metadataAlias.error) return { hasSearch, hasNear, hasCursor, error: metadataAlias.error };
  if (metadataAlias.metadata && bracket.metadata) {
    return {
      hasSearch,
      hasNear,
      hasCursor,
      error: json(
        {
          error: "pass metadata filters as either the JSON `metadata=` param or bracket `meta[field][op]=` form, not both.",
          code: "INVALID_QUERY",
        },
        400,
      ),
    };
  }

  const expandParsed = parseExpandParam(url);
  if (expandParsed.error) return { hasSearch, hasNear, hasCursor, error: expandParsed.error };
  const expand = expandParsed.expand;

  const queryOpts: QueryOpts = {
    tags,
    tagMatch: (parseQuery(url, "tag_match") as "all" | "any") ?? (tags && tags.length > 1 ? "any" : undefined),
    expand,
    excludeTags: parseQueryList(url, "exclude_tag"),
    hasTags: parseBoolOrUndef(parseQuery(url, "has_tags")),
    hasLinks: parseBoolOrUndef(parseQuery(url, "has_links")),
    path: parseQuery(url, "path") ?? undefined,
    pathPrefix: parseQuery(url, "path_prefix") ?? undefined,
    extension: parseExtensionFilter(url),
    metadata: bracket.metadata ?? metadataAlias.metadata,
    createdBy: parseQuery(url, "created_by") ?? undefined,
    lastUpdatedBy: parseQuery(url, "last_updated_by") ?? undefined,
    createdVia: parseQuery(url, "created_via") ?? undefined,
    lastUpdatedVia: parseQuery(url, "last_updated_via") ?? undefined,
    ...(bracket.dateFilter ? { dateFilter: bracket.dateFilter } : {}),
    sort: (parseQuery(url, "sort") as "asc" | "desc") ?? undefined,
    orderBy: parseQuery(url, "order_by") ?? undefined,
    limit: parseInt10(parseQuery(url, "limit")) ?? 50,
    offset: parseInt10(parseQuery(url, "offset")),
    cursor: cursorParam ?? undefined,
  };

  return { queryOpts, hasSearch, hasNear, hasCursor };
}

export function parseIncludeMetadata(url: URL): boolean | string[] | undefined {
  const val = url.searchParams.get("include_metadata");
  if (val === null) return undefined;
  if (val === "true" || val === "1") return true;
  if (val === "false" || val === "0") return false;
  const fields = val.split(",").map((s) => s.trim()).filter(Boolean);
  if (fields.length === 0) return undefined;
  return fields;
}

/** Wikilink-expansion params. Ported from routes.ts:parseExpandParams. */
export function parseExpandParams(
  url: URL,
  db: any,
  tagScope: TagScopeCtx = NO_TAG_SCOPE,
): { ctx: ExpandContext; depth: number } | null {
  if (!parseBool(parseQuery(url, "expand_links"), false)) return null;
  const modeRaw = parseQuery(url, "expand_mode");
  const mode: ExpandMode = modeRaw === "summary" ? "summary" : "full";
  const depth = Math.max(
    0,
    Math.min(parseInt10(parseQuery(url, "expand_depth")) ?? DEFAULT_EXPAND_DEPTH, MAX_EXPAND_DEPTH),
  );
  const isVisible = buildExpandVisibility(tagScope.allowed, tagScope.raw);
  return { ctx: { db, mode, expanded: new Set(), ...(isVisible ? { isVisible } : {}) }, depth };
}

/** Resolve a note by ID or path. Ported from routes.ts:resolveNote. */
export async function resolveNote(store: Store, idOrPath: string): Promise<Note | null> {
  const byId = await store.getNote(idOrPath);
  if (byId) return byId;
  const extMatch = idOrPath.match(/^(.*)\.([a-z0-9]{1,16})$/i);
  if (extMatch) {
    const explicit = await store.getNoteByPath(extMatch[1]!, extMatch[2]!);
    if (explicit) return explicit;
  }
  return await store.getNoteByPath(idOrPath);
}

export async function requireNote(store: Store, idOrPath: string): Promise<Note> {
  const note = await resolveNote(store, idOrPath);
  if (!note) throw new NotFoundError(`Note not found: "${idOrPath}"`);
  return note;
}

/** AmbiguousPathError → 409. Ported from routes.ts:ambiguousPathResponse. */
export function ambiguousPathResponse(e: any): Response | null {
  if (!e || e.code !== "AMBIGUOUS_PATH") return null;
  return json(
    {
      error_type: "ambiguous_path",
      error: "ambiguous_path",
      path: e.path,
      candidates: e.candidates,
      message: e.message,
    },
    409,
  );
}
