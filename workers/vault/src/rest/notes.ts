/**
 * Notes REST surface — GET/POST/PATCH/DELETE /api/notes[/:idOrPath].
 *
 * Ported from parachute-vault/src/routes.ts (handleNotes/handleNotesInner). The
 * query grammar, cursor/content-range handling, optimistic-concurrency +
 * error-shape discriminators, and batch semantics are the shared wire contract
 * (the conformance suite pins them against the bun vault). Two bounded
 * divergences from the bun handler, both isolated here:
 *   - attachment bytes: fs unlink → R2 delete (design ledger: fs ↔ R2).
 *   - transcription: cloud v1 is data-only (design §3.1) — the attachment POST
 *     records the row but does not enqueue a scribe job (no scribe in cloud).
 */
import type { Store, Note, Attachment } from "@openparachute/core/src/types.js";
import {
  getNotes,
  getNoteTags,
  toNoteIndex,
  filterMetadata,
  mergeMetadata,
  MAX_BATCH_SIZE,
  validateExtension,
} from "@openparachute/core/src/notes.js";
import { applyContentRange } from "@openparachute/core/src/content-range.js";
import { attachValidationStatus, enforceStrictWrite } from "@openparachute/core/src/mcp.js";
import { expandContent } from "@openparachute/core/src/expand.js";
import { transactionAsync } from "@openparachute/core/src/txn.js";
import * as linkOps from "@openparachute/core/src/links.js";
import * as tagSchemaOps from "@openparachute/core/src/tag-schemas.js";
import type { ValidationWarning } from "@openparachute/core/src/schema-defaults.js";
import { embeddingsPendingWarning, ignoredParamWarning, type QueryWarning } from "@openparachute/core/src/query-warnings.js";
import {
  json,
  jsonWithWarnings,
  cursorJson,
  parseBool,
  parseQuery,
  parseQueryList,
  parseInt10,
  parseIncludeMetadata,
  parseContentRangeQuery,
  parseExpandParams,
  parseNotesQueryOpts,
  parseExpandParam,
  parseLinkCountDirection,
  resolveNote,
  NotFoundError,
  ambiguousPathResponse,
  type WriteCtx,
  NO_WRITE_CTX,
  type TagScopeCtx,
  NO_TAG_SCOPE,
} from "./parse.js";
import {
  noteWithinTagScope,
  filterNotesByTagScope,
  filterHydratedLinksByTagScope,
  tagsWithinScope,
  tagScopeForbidden,
} from "./tag-scope.js";
import { logStrictBypass } from "./shims.js";
import { bodyWithPendingRestored, segmentPart } from "../transcription/pipeline.js";

/**
 * Runtime deps a handler needs beyond the store. `deleteObject` is provided by
 * the DO so the R2 delete AND the storage-meter decrement stay together in the
 * one place that owns the meter (see VaultDO.deleteObject).
 *
 * `scheduleTranscription` arms the DO's transcription alarm when a
 * `transcribe:true` attachment link lands (cloud#56) — the alarm drains the
 * work off the request path.
 */
export type RestDeps = {
  vaultName: string;
  deleteObject: (relativePath: string) => Promise<void>;
  scheduleTranscription: () => Promise<void>;
};

/** Strict-schema gate — mirrors routes.ts:gateStrictWrite (bun#299). */
function gateStrictWrite(
  store: Store,
  writeCtx: WriteCtx,
  shape: { path?: string | null; tags?: string[]; metadata?: Record<string, unknown> },
): void {
  enforceStrictWrite(store, shape, {
    bypass: writeCtx.bypassStrict === true,
    onBypass: (violations: ValidationWarning[]) => {
      logStrictBypass({
        actor: writeCtx.actor,
        via: writeCtx.via,
        path: shape.path ?? null,
        tags: shape.tags,
        violations,
      });
    },
  });
}

function removeWikilinkBrackets(content: string, targetPath: string): string {
  const escaped = targetPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  content = content.replace(new RegExp(`\\[\\[${escaped}\\|([^\\]]+)\\]\\]`, "gi"), "$1");
  content = content.replace(new RegExp(`\\[\\[${escaped}(#[^\\]]+)?\\]\\]`, "gi"), `${targetPath}$1`);
  return content;
}

function defaultForField(field: { type: string; enum?: string[] }): unknown {
  if (field.enum && field.enum.length > 0) return field.enum[0];
  switch (field.type) {
    case "boolean": return false;
    case "integer": return 0;
    default: return "";
  }
}

/** Tag-schema defaults — mirrors routes.ts:applySchemaDefaults / core mcp.ts. */
async function applySchemaDefaults(store: Store, db: any, noteIds: string[], tags: string[]): Promise<string[]> {
  const schemas = tagSchemaOps.getTagSchemaMap(db);
  if (Object.keys(schemas).length === 0) return [];

  const defaults: Record<string, unknown> = {};
  for (const tag of tags) {
    const schema = schemas[tag];
    if (!schema?.fields) continue;
    for (const [field, fieldSchema] of Object.entries(schema.fields)) {
      if (!(field in defaults)) defaults[field] = defaultForField(fieldSchema);
    }
  }
  if (Object.keys(defaults).length === 0) return [];

  const mutated: string[] = [];
  for (const noteId of noteIds) {
    const note = await store.getNote(noteId);
    if (!note) continue;
    const existing = (note.metadata as Record<string, unknown>) ?? {};
    const missing: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(defaults)) {
      if (!(field in existing)) missing[field] = value;
    }
    if (Object.keys(missing).length === 0) continue;
    await store.updateNote(noteId, { metadata: { ...existing, ...missing }, skipUpdatedAt: true });
    mutated.push(noteId);
  }
  return mutated;
}

/**
 * Failure classes a retry can never fix — the SAME bytes will always fail
 * (too large / too long / undecodable). These stay terminal on retry; every
 * other failed attachment (transient upstream, a since-fixed config, an
 * over-budget cap that may have since reset) resets to pending.
 */
const NON_RETRIABLE_ERROR_CODES = new Set(["audio_too_large", "audio_too_long", "audio_decode_failed"]);

/**
 * POST /notes/:idOrPath/retry-transcription (voice W2) — reset the note's
 * FAILED audio attachments back to pending, restore their pending markers, and
 * re-arm the DO alarm so the pipeline re-runs off the request path. The wire
 * shape mirrors self-host's `handleRetryTranscription` legacy in-body path
 * (the only shape cloud has — cloud never materializes sibling transcript
 * notes): 202 `{ status: "queued", attachment_id, attachment_path,
 * transcript_note_id, worker }`, plus an additive `retried` count for the
 * multi-segment case. A note with nothing retriable answers the honest 400
 * `no_failed_attachment`.
 *
 * The pipeline re-applies ALL its gates naturally on the next wake (entitlement,
 * monthly minutes, size ceiling) — a retry never bypasses them; a still-over-
 * budget memo just re-terminals with the limit marker.
 */
async function handleRetryTranscription(store: Store, note: Note, deps: RestDeps): Promise<Response> {
  const atts = await store.getAttachments(note.id);
  const attMeta = (a: Attachment) => (a.metadata as Record<string, unknown> | undefined) ?? {};
  const failed = atts.filter((a) => attMeta(a).transcribe_status === "failed");
  const retriable = failed.filter((a) => {
    const code = attMeta(a).transcribe_error_code;
    return !(typeof code === "string" && NON_RETRIABLE_ERROR_CODES.has(code));
  });
  if (retriable.length === 0) {
    return json(
      {
        error: "no_failed_attachment",
        error_type: "no_failed_attachment",
        message:
          failed.length > 0
            ? "The note's failed transcription(s) are non-retriable (the audio is too large or long, or could not be decoded)."
            : "The note has no audio attachment with a failed transcription to retry.",
      },
      400,
    );
  }

  // Reset each retriable attachment to pending — preserve `transcribe_origin`
  // and `segment_index`, clear the failure bookkeeping so the pipeline treats
  // it as fresh (attempts/backoff/error/error_code gone).
  for (const att of retriable) {
    const m = { ...attMeta(att) };
    m.transcribe_status = "pending";
    m.transcribe_requested_at = new Date().toISOString();
    m.transcribe_origin = typeof m.transcribe_origin === "string" ? m.transcribe_origin : "legacy";
    delete m.transcribe_attempts;
    delete m.transcribe_backoff_until;
    delete m.transcribe_error;
    delete m.transcribe_error_code;
    delete m.transcribe_done_at;
    await store.setAttachmentMetadata(att.id, m);
  }

  // Restore each retried part's pending marker in the note body (replacing the
  // terminal marker it shows) and RE-STAMP `transcribe_stub` — the terminal
  // write cleared it, and the pipeline's success path gates on it. One read +
  // all restorations + one write, OC-guarded with a single conflict-retry;
  // best-effort (the attachments are already reset, so a lost body write only
  // costs the restored spinner, never the re-transcription itself).
  const parts = retriable.map((a) => segmentPart(attMeta(a)));
  for (let attempt = 0; attempt < 2; attempt++) {
    const fresh = await store.getNote(note.id);
    if (!fresh) break;
    const meta = (fresh.metadata as Record<string, unknown> | undefined) ?? {};
    let content = fresh.content;
    for (const part of parts) content = bodyWithPendingRestored(content, part);
    try {
      await store.updateNote(fresh.id, {
        content,
        metadata: { ...meta, transcribe_stub: true },
        skipUpdatedAt: true,
        if_updated_at: fresh.updatedAt,
      });
      break;
    } catch (err: any) {
      if (!err || err.code !== "CONFLICT" || attempt === 1) break; // give up quietly — attachments already reset
    }
  }

  await deps.scheduleTranscription();

  const first = retriable[0]!;
  return json(
    {
      status: "queued",
      attachment_id: first.id,
      attachment_path: first.path,
      transcript_note_id: note.id,
      worker: "alarm-armed",
      retried: retriable.length,
    },
    202,
  );
}

export async function handleNotes(
  req: Request,
  store: Store,
  subpath: string,
  deps: RestDeps,
  tagScope: TagScopeCtx = NO_TAG_SCOPE,
  writeCtx: WriteCtx = NO_WRITE_CTX,
): Promise<Response> {
  try {
    return await handleNotesInner(req, store, subpath, deps, tagScope, writeCtx);
  } catch (e: any) {
    const ambig = ambiguousPathResponse(e);
    if (ambig) return ambig;
    throw e;
  }
}

async function handleNotesInner(
  req: Request,
  store: Store,
  subpath: string,
  deps: RestDeps,
  tagScope: TagScopeCtx = NO_TAG_SCOPE,
  writeCtx: WriteCtx = NO_WRITE_CTX,
): Promise<Response> {
  const url = new URL(req.url);
  const method = req.method;
  const db = store.db;

  // ---- Collection routes (no ID in path) ----
  if (subpath === "") {
    if (method === "GET") {
      const id = parseQuery(url, "id");
      const search = parseQuery(url, "search");

      // Single note by id/path
      if (id) {
        const note = await resolveNote(store, id);
        if (!note) return json({ error: "Note not found", error_type: "not_found", id }, 404);
        if (!noteWithinTagScope(note, tagScope.allowed, tagScope.raw)) {
          return json({ error: "Note not found", error_type: "not_found", id }, 404);
        }
        const includeContent = parseBool(parseQuery(url, "include_content"), true);
        const contentRange = parseContentRangeQuery(url, includeContent);
        if (contentRange.error) return contentRange.error;
        let result: any = includeContent ? { ...note } : toNoteIndex(note);
        const expand = parseExpandParams(url, db, tagScope);
        if (expand && includeContent && typeof result.content === "string") {
          expand.ctx.expanded.add(note.id);
          result.content = expandContent(result.content, expand.ctx, expand.depth);
        }
        if (contentRange.range && includeContent) applyContentRange(result, contentRange.range);
        result = filterMetadata(result, parseIncludeMetadata(url));
        if (parseBool(parseQuery(url, "include_links"), false)) {
          result.links = filterHydratedLinksByTagScope(
            linkOps.getLinksHydrated(db, note.id),
            tagScope.allowed,
            tagScope.raw,
          );
        }
        if (parseBool(parseQuery(url, "include_attachments"), false)) {
          result.attachments = await store.getAttachments(note.id);
        }
        if (parseBool(parseQuery(url, "include_link_count"), false)) {
          result.linkCount = linkOps.getLinkCounts(db, [note.id], parseLinkCountDirection(url)).get(note.id) ?? 0;
        }
        return json(result);
      }

      // Semantic search (EXPERIMENTAL — semantic search MVP, C2). Ported
      // verbatim from parachute-vault/src/routes.ts (the wire contract lives
      // in this branch, so it is transcribed rather than reinvented — the
      // conformance suite pins any drift). Checked BEFORE the search/cursor
      // exclusivity check below so `semantic=true` combined with `search=`
      // or `cursor=` gets its OWN error naming `semantic`, not silently
      // routed into the search branch.
      const nearText = parseQuery(url, "near_text");
      const semantic = parseBool(parseQuery(url, "semantic"), false);
      if (semantic) {
        if (search) {
          return json(
            {
              error: "semantic is incompatible with full-text search — pick one (semantic ranks by meaning via near_text; search ranks by keyword).",
              code: "INVALID_QUERY",
              error_type: "invalid_query",
              field: "semantic",
              hint: "drop `search` when using `semantic`, or drop `semantic`/`near_text` to use keyword search",
            },
            400,
          );
        }
        if (parseQuery(url, "cursor") !== null) {
          return json(
            {
              error: "cursor is incompatible with semantic search — ranking is by similarity, not a stable row order to page through.",
              code: "INVALID_QUERY",
              error_type: "invalid_query",
              field: "semantic",
              hint: "drop `cursor` when using `semantic`",
            },
            400,
          );
        }
        if (!nearText || !nearText.trim()) {
          return json(
            {
              error: "semantic=true requires `near_text` — the free text to rank notes by meaning.",
              code: "INVALID_QUERY",
              error_type: "invalid_query",
              field: "near_text",
              hint: "pass ?near_text=...&semantic=true",
            },
            400,
          );
        }
        const parsedSemantic = parseNotesQueryOpts(url);
        if (parsedSemantic.error) return parsedSemantic.error;
        try {
          const semanticResult = await store.semanticSearch(nearText, { ...parsedSemantic.queryOpts, cursor: undefined });
          const semanticWarnings: QueryWarning[] = [];
          if (semanticResult.pendingCount > 0) {
            semanticWarnings.push(
              embeddingsPendingWarning(semanticResult.pendingCount, semanticResult.totalCandidates),
            );
          }
          const filtered = filterNotesByTagScope(semanticResult.notes, tagScope.allowed, tagScope.raw);
          const includeContent = parseBool(parseQuery(url, "include_content"), false);
          const contentRange = parseContentRangeQuery(url, includeContent);
          if (contentRange.error) return contentRange.error;
          const inclMeta = parseIncludeMetadata(url);
          let output: any[] = includeContent ? filtered.map((n) => ({ ...n })) : filtered.map(toNoteIndex);
          const expand = parseExpandParams(url, db, tagScope);
          if (expand && includeContent) {
            for (const n of output) expand.ctx.expanded.add(n.id);
            for (const n of output) {
              if (typeof n.content === "string") {
                n.content = expandContent(n.content, expand.ctx, expand.depth);
              }
            }
          }
          if (contentRange.range && includeContent) {
            for (const n of output) applyContentRange(n, contentRange.range);
          }
          if (inclMeta !== undefined && inclMeta !== true) {
            output = output.map((n: any) => filterMetadata(n, inclMeta));
          }
          if (parseBool(parseQuery(url, "include_link_count"), false)) {
            const counts = linkOps.getLinkCounts(db, output.map((n: any) => n.id), parseLinkCountDirection(url));
            for (const n of output) n.linkCount = counts.get(n.id) ?? 0;
          }
          return jsonWithWarnings(output, semanticWarnings);
        } catch (e: any) {
          if (e && e.name === "QueryError") {
            // `semantic_unavailable` (no/not-ready provider) is a capability
            // gap, not a malformed request — 503, distinct from every other
            // QueryError's 400. Never a silent fallback to keyword search.
            const status = e.error_type === "semantic_unavailable" ? 503 : 400;
            return json(
              {
                error: e.message,
                code: e.code ?? "INVALID_QUERY",
                error_type: e.error_type ?? "invalid_query",
                ...(e.field !== undefined ? { field: e.field } : {}),
                ...(e.got !== undefined ? { got: e.got } : {}),
                ...(e.hint !== undefined ? { hint: e.hint } : {}),
              },
              status,
            );
          }
          throw e;
        }
      }

      // `near_text` without `semantic: true` is inert — ported from
      // routes.ts:1330-1332 (byte-shape parity: same code/message/param).
      // Rather than a whole extra branch, this warning rides whichever
      // normal path (search or structured query) actually runs below.
      const nearTextIgnored: QueryWarning[] = nearText !== null
        ? [ignoredParamWarning("near_text", "`semantic=true` is required to activate near_text — pass both together")]
        : [];

      if (search && url.searchParams.has("cursor")) {
        return json(
          {
            error: "cursor is incompatible with full-text search — FTS has its own ordering. Use date_filter on updated_at for since-last-checked search.",
            code: "INVALID_QUERY",
            error_type: "invalid_query",
            field: "cursor",
            hint: "drop `cursor` when using `search`, or drop `search` and use `meta[updated_at][gte]=…` for since-last-checked polling",
          },
          400,
        );
      }

      // Full-text search
      if (search) {
        const searchTags = parseQueryList(url, "tag");
        const limit = parseInt10(parseQuery(url, "limit")) ?? 50;
        const tagExpand = parseExpandParam(url);
        if (tagExpand.error) return tagExpand.error;
        // `offset` under full-text search (contracts-brief V1.2/C1.3): search
        // has no stable row order to offset into — results are always page 1,
        // ranked by relevance. Warn rather than silently ignore (the
        // structured-query path below has real offset support, unaffected).
        const searchWarnings: QueryWarning[] = [...nearTextIgnored];
        if (parseQuery(url, "offset") !== null) {
          searchWarnings.push({
            code: "ignored_param",
            message: "`offset` has no effect: full-text search has no stable row order to offset into — results are always page 1, ranked by relevance",
            param: "offset",
          });
        }
        // `search_mode` + `sort`-under-search (contracts-brief item 2/C1.5):
        // cloud v1 has no `search_mode` (advanced FTS5 syntax) or `sort`
        // (relevance vs created_at) support under full-text search — bun
        // honors both (vault#551). Rather than silently ignore (wrong
        // results with no signal), name them loudly; a full port rides the
        // shared-core merge.
        if (parseQuery(url, "search_mode") !== null) {
          searchWarnings.push({
            code: "unsupported_param",
            message: "`search_mode` is not supported on cloud v1 — search always runs in literal mode. No effect on results.",
            param: "search_mode",
          });
        }
        if (parseQuery(url, "sort") !== null) {
          searchWarnings.push({
            code: "unsupported_param",
            message: "`sort` is not supported under full-text search on cloud v1 — results are always ranked by relevance. No effect on results.",
            param: "sort",
          });
        }
        let rawResults: Note[];
        try {
          rawResults = await store.searchNotes(search, { tags: searchTags, limit, expand: tagExpand.expand });
        } catch (e: any) {
          if (e && e.name === "QueryError") {
            return json(
              {
                error: e.message,
                code: e.code ?? "INVALID_QUERY",
                error_type: e.error_type ?? "invalid_query",
                ...(e.field !== undefined ? { field: e.field } : {}),
                ...(e.got !== undefined ? { got: e.got } : {}),
                ...(e.hint !== undefined ? { hint: e.hint } : {}),
              },
              400,
            );
          }
          throw e;
        }
        const results = filterNotesByTagScope(rawResults, tagScope.allowed, tagScope.raw);
        const includeContent = parseBool(parseQuery(url, "include_content"), false);
        const contentRange = parseContentRangeQuery(url, includeContent);
        if (contentRange.error) return contentRange.error;
        const inclMeta = parseIncludeMetadata(url);
        let output: any[] = includeContent ? results.map((n) => ({ ...n })) : results.map(toNoteIndex);
        const expand = parseExpandParams(url, db, tagScope);
        if (expand && includeContent) {
          for (const n of output) expand.ctx.expanded.add(n.id);
          for (const n of output) {
            if (typeof n.content === "string") n.content = expandContent(n.content, expand.ctx, expand.depth);
          }
        }
        if (contentRange.range && includeContent) {
          for (const n of output) applyContentRange(n, contentRange.range);
        }
        if (inclMeta !== undefined && inclMeta !== true) {
          output = output.map((n: any) => filterMetadata(n, inclMeta));
        }
        if (parseBool(parseQuery(url, "include_link_count"), false)) {
          const counts = linkOps.getLinkCounts(db, output.map((n: any) => n.id), parseLinkCountDirection(url));
          for (const n of output) n.linkCount = counts.get(n.id) ?? 0;
        }
        return jsonWithWarnings(output, searchWarnings);
      }

      // Structured query.
      //
      // Cursor mode is PRESENCE-based (`?cursor=` set at all, even empty) so an
      // agent loop can bootstrap over HTTP: a bare first call with no cursor
      // yields a flat array (no watermark), but `?cursor=` (empty) returns the
      // `{notes, next_cursor}` envelope + first watermark — matching
      // HTTP_API.md's documented cycle ("wrapped envelope when ?cursor= is
      // set").
      //
      // The empty string is carried THROUGH to core, not folded to undefined
      // (cloud#112, porting vault#559). Core keys cursor mode on
      // `opts.cursor !== undefined` — `""` is the bootstrap value that engages
      // the keyset `ORDER BY (updated_at_ms, id)` with no boundary predicate;
      // `undefined` means "no cursor at all" and leaves the default
      // `created_at` order in place. Folding `""` → `undefined` here made
      // page 1 of a bootstrap walk run UNORDERED relative to the watermark it
      // then minted, so every note excluded from that page whose `updated_at`
      // fell below the watermark was silently skipped for the rest of the
      // walk. Only an absent param (`null`) may become `undefined`.
      const parsed = parseNotesQueryOpts(url);
      if (parsed.error) return parsed.error;
      const queryOpts = parsed.queryOpts!;
      const hasCursorParam = url.searchParams.has("cursor");
      const cursorParam = parseQuery(url, "cursor");
      queryOpts.cursor = cursorParam ?? undefined;
      const nearNoteIdEarly = parseQuery(url, "near[note_id]");
      if (hasCursorParam && nearNoteIdEarly) {
        return json(
          {
            error: "cursor is incompatible with near (graph neighborhood). Resolve the neighborhood first, then iterate with cursor over the resulting note set.",
            code: "INVALID_QUERY",
            error_type: "invalid_query",
            field: "cursor",
            hint: "resolve the `near` neighborhood first, then paginate the resulting note set with `cursor`",
          },
          400,
        );
      }
      let results: Note[];
      let nextCursor: string | null = null;
      try {
        if (hasCursorParam) {
          const page = await store.queryNotesPaged(queryOpts);
          results = page.notes;
          nextCursor = page.next_cursor;
        } else {
          results = await store.queryNotes(queryOpts);
        }
      } catch (e: any) {
        if (e && e.name === "QueryError") {
          return json(
            {
              error: e.message,
              code: e.code ?? "INVALID_QUERY",
              error_type: e.error_type ?? "invalid_query",
              ...(e.field !== undefined ? { field: e.field } : {}),
              ...(e.got !== undefined ? { got: e.got } : {}),
              ...(e.hint !== undefined ? { hint: e.hint } : {}),
            },
            400,
          );
        }
        if (e && e.name === "CursorError") {
          return json({ error: e.message, code: e.code ?? "cursor_invalid", error_type: e.code ?? "cursor_invalid" }, 400);
        }
        throw e;
      }

      const nearNoteId = parseQuery(url, "near[note_id]");
      if (nearNoteId) {
        const anchor = await resolveNote(store, nearNoteId);
        if (!anchor) return json({ error: "Anchor note not found", error_type: "not_found", note_id: nearNoteId }, 404);
        if (!noteWithinTagScope(anchor, tagScope.allowed, tagScope.raw)) {
          return json({ error: "Anchor note not found", error_type: "not_found", note_id: nearNoteId }, 404);
        }
        const depth = Math.min(parseInt10(parseQuery(url, "near[depth]")) ?? 2, 5);
        const relationship = parseQuery(url, "near[relationship]") ?? undefined;
        const isTraversable = tagScope.raw
          ? (id: string) =>
              noteWithinTagScope({ id, tags: getNoteTags(db, id) } as Note, tagScope.allowed, tagScope.raw)
          : undefined;
        const traversed = linkOps.traverseLinks(db, anchor.id, { max_depth: depth, relationship, isTraversable });
        const nearScope = new Set([anchor.id, ...traversed.map((t) => t.noteId)]);
        results = results.filter((n) => nearScope.has(n.id));
      }

      results = filterNotesByTagScope(results, tagScope.allowed, tagScope.raw);

      const includeContent = parseBool(parseQuery(url, "include_content"), false);
      const contentRange = parseContentRangeQuery(url, includeContent);
      if (contentRange.error) return contentRange.error;
      const includeLinks = parseBool(parseQuery(url, "include_links"), false);
      const includeAttachments = parseBool(parseQuery(url, "include_attachments"), false);
      const includeLinkCount = parseBool(parseQuery(url, "include_link_count"), false);
      const inclMeta = parseIncludeMetadata(url);
      let output: any[] = includeContent ? results.map((n) => ({ ...n })) : results.map(toNoteIndex);
      const expand = parseExpandParams(url, db, tagScope);
      if (expand && includeContent) {
        for (const n of output) expand.ctx.expanded.add(n.id);
        for (const n of output) {
          if (typeof n.content === "string") n.content = expandContent(n.content, expand.ctx, expand.depth);
        }
      }
      if (contentRange.range && includeContent) {
        for (const n of output) applyContentRange(n, contentRange.range);
      }
      if (inclMeta !== undefined && inclMeta !== true) {
        output = output.map((n: any) => filterMetadata(n, inclMeta));
      }
      if (includeLinkCount) {
        const counts = linkOps.getLinkCounts(db, output.map((n: any) => n.id), parseLinkCountDirection(url));
        for (const n of output) n.linkCount = counts.get(n.id) ?? 0;
      }

      if (parseQuery(url, "format") === "graph") {
        const resultIds = new Set(results.map((n) => n.id));
        const nodes = output.map((n: any) => ({ id: n.id, path: n.path ?? null, tags: n.tags ?? [] }));
        const edges: { source: string; target: string; relationship: string }[] = [];
        if (includeLinks) {
          const linksByNote = linkOps.getLinksHydratedForNotes(db, results.map((n) => n.id));
          for (const n of results) {
            for (const link of linksByNote.get(n.id) ?? []) {
              if (link.sourceId === n.id && resultIds.has(link.targetId)) {
                edges.push({ source: link.sourceId, target: link.targetId, relationship: link.relationship });
              }
            }
          }
        }
        return json({ nodes, edges });
      }

      if (includeLinks || includeAttachments) {
        const linksByNote = includeLinks
          ? linkOps.getLinksHydratedForNotes(db, output.map((n: any) => n.id))
          : null;
        const enrichedOut: any[] = [];
        for (const n of output) {
          const enriched: any = { ...n };
          if (linksByNote) {
            enriched.links = filterHydratedLinksByTagScope(
              linksByNote.get(n.id) ?? [],
              tagScope.allowed,
              tagScope.raw,
            );
          }
          if (includeAttachments) enriched.attachments = await store.getAttachments(n.id);
          enrichedOut.push(enriched);
        }
        if (hasCursorParam) return cursorJson(enrichedOut, nextCursor);
        return jsonWithWarnings(enrichedOut, nearTextIgnored);
      }

      if (hasCursorParam) return cursorJson(output, nextCursor);
      return jsonWithWarnings(output, nearTextIgnored);
    }

    // POST /notes — create (single or batch)
    if (method === "POST") {
      const body = await req.json() as any;
      const items: any[] = body.notes ?? [body];

      if (items.length > MAX_BATCH_SIZE) {
        return json(
          {
            error_type: "batch_too_large",
            error: "BatchTooLarge",
            message: `max ${MAX_BATCH_SIZE} notes per request, got ${items.length}`,
            limit: MAX_BATCH_SIZE,
          },
          413,
        );
      }

      if (tagScope.allowed) {
        for (let i = 0; i < items.length; i++) {
          if (!tagsWithinScope(items[i]?.tags, tagScope.allowed, tagScope.raw)) {
            return tagScopeForbidden(tagScope.raw ?? []);
          }
        }
      }

      const created: Note[] = [];
      const batched = items.length > 1;
      const runBatch = async (): Promise<void> => {
        for (const item of items) {
          const extension = item.extension !== undefined ? validateExtension(item.extension) : undefined;
          gateStrictWrite(store, writeCtx, { path: item.path, tags: item.tags, metadata: item.metadata });
          const note = await store.createNote(item.content ?? "", {
            id: item.id,
            path: item.path,
            tags: item.tags,
            metadata: item.metadata,
            created_at: item.createdAt ?? item.created_at,
            ...(extension !== undefined ? { extension } : {}),
            actor: writeCtx.actor,
            via: writeCtx.via,
          });
          if (item.links) {
            for (const link of item.links as { target: string; relationship: string }[]) {
              const target = await resolveNote(store, link.target);
              if (target) await store.createLink(note.id, target.id, link.relationship);
            }
          }
          created.push((await store.getNote(note.id)) ?? note);
        }
      };
      try {
        await (batched ? transactionAsync(db, runBatch) : runBatch());
      } catch (e: any) {
        if (e && e.code === "PATH_CONFLICT") {
          return json({ error_type: "path_conflict", error: "path_conflict", path: e.path, message: e.message }, 409);
        }
        if (e && e.code === "SCHEMA_VALIDATION") {
          return json({ error_type: "schema_validation", error: "schema_validation", violations: e.violations ?? [], message: e.message }, 422);
        }
        if (e && e.code === "INVALID_EXTENSION") {
          return json({ error_type: "invalid_extension", error: "invalid_extension", extension: e.extension, reason: e.reason, message: e.message }, 400);
        }
        throw e;
      }

      const mutatedIds = new Set<string>();
      for (const note of created) {
        if (note.tags?.length) {
          for (const id of await applySchemaDefaults(store, db, [note.id], note.tags)) mutatedIds.add(id);
        }
      }
      const refreshed =
        mutatedIds.size === 0
          ? created
          : (() => {
              const byId = new Map(getNotes(db, [...mutatedIds]).map((n) => [n.id, n]));
              return created.map((n) => byId.get(n.id) ?? n);
            })();

      const final = refreshed.map((n) => attachValidationStatus(store, db, n));
      return json(body.notes ? final : final[0], 201);
    }

    return json({ error: "Method not allowed", error_type: "method_not_allowed" }, 405);
  }

  // ---- Note-level routes (/notes/:idOrPath[/attachments]) ----
  const idMatch = subpath.match(/^\/([^/]+)(\/.*)?$/);
  if (!idMatch) return json({ error: "Not found", error_type: "not_found" }, 404);

  const idOrPath = decodeURIComponent(idMatch[1]!);
  const sub = idMatch[2] ?? "";

  // Attachments sub-routes
  if (sub === "/attachments") {
    if (method === "POST") {
      const note = await resolveNote(store, idOrPath);
      if (!note) return json({ error: "Not found", error_type: "not_found" }, 404);
      if (!noteWithinTagScope(note, tagScope.allowed, tagScope.raw)) return json({ error: "Not found", error_type: "not_found" }, 404);
      const body = await req.json() as { path: string; mimeType: string; transcribe?: boolean; segment_index?: unknown };
      if (!body.path || !body.mimeType) {
        return json(
          { error: "path and mimeType are required", error_type: "missing_required_field", hint: "pass both `path` and `mimeType`" },
          400,
        );
      }
      // Voice transcription (cloud#56): on `transcribe:true`, stamp the
      // attachment `pending` (the DB IS the queue — the same shape the self-host
      // worker uses) and mark the owning note as a transcribe stub, then arm the
      // DO alarm to drain it off the request path. The alarm enforces the plan
      // entitlement + monthly minutes cap; a vault without voice resolves the
      // note to an honest marker rather than an eternal spinner. Without the
      // flag it's a plain data attachment (Daily / non-voice callers).
      //
      // Per-segment slots (voice W2): an optional `segment_index` (integer ≥ 0)
      // lets one recording split across several attachments on ONE note, each
      // resolving into its own `(part N)` marker (N = segment_index + 1). Stored
      // on the attachment metadata so the pipeline reads it at completion time;
      // a malformed value is ignored (falls back to the bare, un-segmented
      // markers). Only meaningful alongside `transcribe:true`.
      const optIn = body.transcribe === true;
      const segIdx = body.segment_index;
      const validSegment = typeof segIdx === "number" && Number.isInteger(segIdx) && segIdx >= 0;
      const attMeta = optIn
        ? {
            transcribe_status: "pending" as const,
            transcribe_requested_at: new Date().toISOString(),
            transcribe_origin: "legacy" as const,
            ...(validSegment ? { segment_index: segIdx } : {}),
          }
        : undefined;
      const attachment = await store.addAttachment(note.id, body.path, body.mimeType, attMeta);
      if (optIn) {
        const noteMeta = (note.metadata as Record<string, unknown> | undefined) ?? {};
        if (noteMeta.transcribe_stub !== true) {
          await store.updateNote(note.id, {
            metadata: { ...noteMeta, transcribe_stub: true },
            skipUpdatedAt: true,
          });
        }
        await deps.scheduleTranscription();
      }
      return json(attachment, 201);
    }
    if (method === "GET") {
      const note = await resolveNote(store, idOrPath);
      if (!note) return json({ error: "Not found", error_type: "not_found" }, 404);
      if (!noteWithinTagScope(note, tagScope.allowed, tagScope.raw)) return json({ error: "Not found", error_type: "not_found" }, 404);
      return json(await store.getAttachments(note.id));
    }
    return json({ error: "Method not allowed", error_type: "method_not_allowed" }, 405);
  }

  // Retry transcription — POST /notes/:idOrPath/retry-transcription (voice W2,
  // door parity with self-host's own route). Write-scoped (the DO's verb gate
  // already 403s a read token before this handler runs). Re-runs transcription
  // for the note's FAILED audio attachments; a non-retriable failure class
  // (audio_too_large/…) stays terminal.
  if (sub === "/retry-transcription") {
    if (method !== "POST") return json({ error: "Method not allowed", error_type: "method_not_allowed" }, 405);
    const note = await resolveNote(store, idOrPath);
    if (!note) return json({ error: "Not found", error_type: "not_found" }, 404);
    if (!noteWithinTagScope(note, tagScope.allowed, tagScope.raw)) return json({ error: "Not found", error_type: "not_found" }, 404);
    return handleRetryTranscription(store, note, deps);
  }

  const attMatch = sub.match(/^\/attachments\/([^/]+)$/);
  if (attMatch) {
    const attId = decodeURIComponent(attMatch[1]!);
    if (method === "DELETE") {
      const note = await resolveNote(store, idOrPath);
      if (!note) return json({ error: "Not found", error_type: "not_found" }, 404);
      if (!noteWithinTagScope(note, tagScope.allowed, tagScope.raw)) return json({ error: "Not found", error_type: "not_found" }, 404);
      const result = await store.deleteAttachment(note.id, attId);
      if (!result.deleted) return json({ error: "Not found", error_type: "not_found" }, 404);
      // Orphan-delete the R2 object only when no other attachment references it
      // (bun unlinks the fs file here; cloud deletes the R2 key AND decrements
      // the storage meter — deleteObject owns both, see VaultDO.deleteObject).
      if (result.path && result.orphaned) {
        try { await deps.deleteObject(result.path); } catch {}
      }
      return new Response(null, { status: 204 });
    }
    return json({ error: "Method not allowed", error_type: "method_not_allowed" }, 405);
  }

  if (sub !== "") return json({ error: "Not found", error_type: "not_found" }, 404);

  // GET /notes/:idOrPath — single note
  if (method === "GET") {
    const note = await resolveNote(store, idOrPath);
    if (!note) return json({ error: "Not found", error_type: "not_found" }, 404);
    if (!noteWithinTagScope(note, tagScope.allowed, tagScope.raw)) return json({ error: "Not found", error_type: "not_found" }, 404);
    const includeContent = parseBool(parseQuery(url, "include_content"), true);
    const contentRange = parseContentRangeQuery(url, includeContent);
    if (contentRange.error) return contentRange.error;
    let result: any = includeContent ? { ...note } : toNoteIndex(note);
    const expand = parseExpandParams(url, db, tagScope);
    if (expand && includeContent && typeof result.content === "string") {
      expand.ctx.expanded.add(note.id);
      result.content = expandContent(result.content, expand.ctx, expand.depth);
    }
    if (contentRange.range && includeContent) applyContentRange(result, contentRange.range);
    result = filterMetadata(result, parseIncludeMetadata(url));
    if (parseBool(parseQuery(url, "include_links"), false)) {
      result.links = filterHydratedLinksByTagScope(
        linkOps.getLinksHydrated(db, note.id),
        tagScope.allowed,
        tagScope.raw,
      );
    }
    if (parseBool(parseQuery(url, "include_attachments"), false)) {
      result.attachments = await store.getAttachments(note.id);
    }
    if (parseBool(parseQuery(url, "include_link_count"), false)) {
      result.linkCount = linkOps.getLinkCounts(db, [note.id], parseLinkCountDirection(url)).get(note.id) ?? 0;
    }
    return json(result);
  }

  // PATCH /notes/:idOrPath — update
  if (method === "PATCH") {
    try {
      const body = await req.json() as any;
      const note = await resolveNote(store, idOrPath);
      if (!note) {
        if (body.if_missing === "create") {
          const idOrPathStr = idOrPath;
          const tagsArr = Array.isArray(body.tags)
            ? body.tags as string[]
            : Array.isArray(body.tags?.add) ? body.tags.add as string[] : [];
          if (tagScope.allowed && !tagsWithinScope(tagsArr, tagScope.allowed, tagScope.raw)) {
            return tagScopeForbidden(tagScope.raw ?? []);
          }
          const idLooksLikePath = idOrPathStr.includes("/") || !/^[A-Za-z0-9_-]+$/.test(idOrPathStr);
          const explicitPath = typeof body.path === "string" ? body.path as string : undefined;
          const createExt = body.extension !== undefined ? validateExtension(body.extension) : undefined;
          const createOpts: Parameters<Store["createNote"]>[1] = {
            ...(idLooksLikePath ? { path: explicitPath ?? idOrPathStr } : { id: idOrPathStr, ...(explicitPath !== undefined ? { path: explicitPath } : {}) }),
            ...(tagsArr.length > 0 ? { tags: tagsArr } : {}),
            ...(body.metadata !== undefined ? { metadata: body.metadata as Record<string, unknown> } : {}),
            ...(body.created_at !== undefined ? { created_at: body.created_at as string } : {}),
            ...(body.createdAt !== undefined ? { created_at: body.createdAt as string } : {}),
            ...(createExt !== undefined ? { extension: createExt } : {}),
            actor: writeCtx.actor,
            via: writeCtx.via,
          };
          const content = (body.content as string | undefined) ?? "";
          gateStrictWrite(store, writeCtx, {
            path: createOpts.path ?? undefined,
            tags: createOpts.tags,
            metadata: createOpts.metadata,
          });
          const createdNote = await store.createNote(content, createOpts);
          if (tagsArr.length > 0) await applySchemaDefaults(store, db, [createdNote.id], tagsArr);
          const linksAdd = (body.links as any)?.add as { target: string; relationship: string; metadata?: Record<string, unknown> }[] | undefined;
          if (linksAdd) {
            for (const link of linksAdd) {
              const target = await resolveNote(store, link.target);
              if (target) await store.createLink(createdNote.id, target.id, link.relationship, link.metadata);
            }
          }
          const finalNote = await store.getNote(createdNote.id);
          if (!finalNote) return json({ error: "Note disappeared", error_type: "internal_error" }, 500);
          const validated = attachValidationStatus(store, db, finalNote);
          const includeContentResp = body.include_content !== false;
          if (includeContentResp) return json({ ...validated, created: true });
          const lean: any = toNoteIndex(validated);
          const vs = (validated as any).validation_status;
          if (vs !== undefined) lean.validation_status = vs;
          lean.created = true;
          return json(lean);
        }
        throw new NotFoundError(`Note not found: "${idOrPath}"`);
      }
      if (!noteWithinTagScope(note, tagScope.allowed, tagScope.raw)) {
        throw new NotFoundError(`Note not found: "${idOrPath}"`);
      }
      if (tagScope.allowed) {
        const removed = new Set<string>((body.tags?.remove as string[] | undefined) ?? []);
        const projected = new Set<string>((note.tags ?? []).filter((t) => !removed.has(t)));
        for (const t of (body.tags?.add as string[] | undefined) ?? []) projected.add(t);
        if (!tagsWithinScope([...projected], tagScope.allowed, tagScope.raw)) {
          return tagScopeForbidden(tagScope.raw ?? []);
        }
      }

      const hasContent = body.content !== undefined;
      const hasAppendPrepend = body.append !== undefined || body.prepend !== undefined;
      const hasContentEdit = body.content_edit !== undefined;
      const contentModes = (hasContent ? 1 : 0) + (hasAppendPrepend ? 1 : 0) + (hasContentEdit ? 1 : 0);
      if (contentModes > 1) {
        return json(
          {
            error: "mutually_exclusive",
            error_type: "mutually_exclusive",
            message: "`content`, `append`/`prepend`, and `content_edit` are mutually exclusive — pick one mode of content update.",
          },
          400,
        );
      }

      const isAppendOnly = hasAppendPrepend
        && !hasContent && !hasContentEdit
        && body.path === undefined && body.metadata === undefined
        && body.created_at === undefined && body.createdAt === undefined
        && body.tags === undefined && body.links === undefined;
      const isTransitionOnly = body.state_transition !== undefined
        && !hasContent && !hasAppendPrepend && !hasContentEdit
        && body.path === undefined && body.metadata === undefined
        && body.created_at === undefined && body.createdAt === undefined
        && body.tags === undefined && body.links === undefined;
      if (!isAppendOnly && !isTransitionOnly && body.if_updated_at === undefined && body.force !== true) {
        return json(
          {
            error_type: "precondition_required",
            error: "precondition_required",
            message: "update requires `if_updated_at` (the note's last-seen updated_at) or `force: true`.",
            note_id: note.id,
            path: note.path ?? null,
          },
          428,
        );
      }

      let contentOverride = body.content as string | undefined;
      if (hasContentEdit) {
        const ce = body.content_edit as { old_text?: unknown; new_text?: unknown };
        if (typeof ce?.old_text !== "string" || typeof ce?.new_text !== "string") {
          return json(
            {
              error: "bad_request",
              error_type: "invalid_content_edit",
              field: "content_edit",
              message: "`content_edit` requires { old_text: string, new_text: string }.",
              hint: "pass { old_text: string, new_text: string }",
            },
            400,
          );
        }
        const idx = note.content.indexOf(ce.old_text);
        if (idx < 0) {
          // 422, not 404: the note exists and the request is syntactically
          // valid — only the search string can't be applied to the current
          // content. A 404 here implied "note doesn't exist" (vault#202).
          return json(
            {
              error: "unprocessable_content",
              error_type: "content_edit_not_found",
              field: "content_edit.old_text",
              message: `content_edit: \`old_text\` not found in note "${note.id}". Re-read and retry.`,
              hint: "re-read the note's current content and retry with an old_text that occurs exactly once",
            },
            422,
          );
        }
        const second = note.content.indexOf(ce.old_text, idx + 1);
        if (second >= 0) {
          return json(
            {
              error: "ambiguous",
              error_type: "content_edit_ambiguous",
              field: "content_edit.old_text",
              message: `content_edit: \`old_text\` matches multiple times in note "${note.id}" — must match exactly once. Add surrounding context.`,
              hint: "add surrounding context to old_text so it matches exactly once",
            },
            409,
          );
        }
        contentOverride = note.content.slice(0, idx) + ce.new_text + note.content.slice(idx + ce.old_text.length);
      }

      const linksRemove = body.links?.remove as { target: string; relationship: string }[] | undefined;
      const resolvedLinksToRemove: { targetId: string; relationship: string }[] = [];
      if (linksRemove) {
        for (const link of linksRemove) {
          const target = await resolveNote(store, link.target);
          if (!target) continue;
          resolvedLinksToRemove.push({ targetId: target.id, relationship: link.relationship });
          if (link.relationship === "wikilink" && target.path) {
            const current = contentOverride
              ?? (hasAppendPrepend
                ? (body.prepend as string ?? "") + note.content + (body.append as string ?? "")
                : note.content);
            const cleaned = removeWikilinkBrackets(current, target.path);
            if (cleaned !== current) contentOverride = cleaned;
          }
        }
      }

      const updates: any = {};
      if (contentOverride !== undefined) {
        updates.content = contentOverride;
      } else if (hasAppendPrepend) {
        if (body.append !== undefined) updates.append = body.append;
        if (body.prepend !== undefined) updates.prepend = body.prepend;
      }
      if (body.path !== undefined) updates.path = body.path;
      if (body.extension !== undefined) updates.extension = validateExtension(body.extension);
      if (body.metadata !== undefined) {
        updates.metadata = mergeMetadata(
          note.metadata as Record<string, unknown> | null | undefined,
          body.metadata as Record<string, unknown>,
        );
      }
      if (body.created_at !== undefined || body.createdAt !== undefined) {
        updates.created_at = body.created_at ?? body.createdAt;
      }
      if (body.if_updated_at !== undefined) updates.if_updated_at = body.if_updated_at;
      const stBody = body.state_transition as { field?: unknown; from?: unknown; to?: unknown } | undefined;
      if (stBody !== undefined) {
        if (typeof stBody.field !== "string" || stBody.field.length === 0) {
          return json(
            {
              error: "bad_request",
              error_type: "invalid_state_transition",
              field: "state_transition.field",
              message: "`state_transition.field` must be a non-empty string.",
              hint: "pass a non-empty string naming the metadata field to transition",
            },
            400,
          );
        }
        updates.state_transition = { field: stBody.field, from: stBody.from, to: stBody.to };
      }

      {
        const removeSet = new Set<string>((body.tags?.remove as string[] | undefined) ?? []);
        const projectedTags = new Set<string>((note.tags ?? []).filter((t) => !removeSet.has(t)));
        for (const t of (body.tags?.add as string[] | undefined) ?? []) projectedTags.add(t);
        const baseMeta = updates.metadata ?? ((note.metadata as Record<string, unknown>) ?? {});
        const projectedMeta = stBody !== undefined ? { ...baseMeta, [stBody.field as string]: stBody.to } : baseMeta;
        gateStrictWrite(store, writeCtx, { path: note.path, tags: [...projectedTags], metadata: projectedMeta });
      }

      if (Object.keys(updates).length > 0) {
        updates.actor = writeCtx.actor;
        updates.via = writeCtx.via;
        await store.updateNote(note.id, updates);
      }

      for (const { targetId, relationship } of resolvedLinksToRemove) {
        await store.deleteLink(note.id, targetId, relationship);
      }

      if (body.tags?.add?.length) {
        await store.tagNote(note.id, body.tags.add);
        await applySchemaDefaults(store, db, [note.id], body.tags.add);
      }
      if (body.tags?.remove?.length) {
        await store.untagNote(note.id, body.tags.remove);
      }

      if (body.links?.add) {
        for (const link of body.links.add as { target: string; relationship: string; metadata?: Record<string, unknown> }[]) {
          const target = await resolveNote(store, link.target);
          if (target) await store.createLink(note.id, target.id, link.relationship, link.metadata);
        }
      }

      const updatedNote = await store.getNote(note.id);
      if (updatedNote === null) return json({ error: "Note disappeared", error_type: "not_found" }, 404);
      const validated: any = attachValidationStatus(store, db, updatedNote);
      const linkMutated = body.links?.add !== undefined || body.links?.remove !== undefined;
      const includeLinksResp = linkMutated || parseBool(parseQuery(url, "include_links"), false);
      if (includeLinksResp) {
        validated.links = filterHydratedLinksByTagScope(
          linkOps.getLinksHydrated(db, updatedNote.id),
          tagScope.allowed,
          tagScope.raw,
        );
      }
      const includeContentResp = body.include_content !== false;
      if (includeContentResp) return json({ ...validated, created: false });
      const lean: any = toNoteIndex(validated);
      const vs = (validated as any).validation_status;
      if (vs !== undefined) lean.validation_status = vs;
      if (validated.links !== undefined) lean.links = validated.links;
      lean.created = false;
      return json(lean);
    } catch (e: any) {
      if (e instanceof NotFoundError) return json({ error: e.message, error_type: "not_found" }, 404);
      if (e && e.code === "CONFLICT") {
        return json(
          {
            error_type: "conflict",
            current_updated_at: e.current_updated_at ?? null,
            your_updated_at: e.expected_updated_at,
            path: e.note_path ?? null,
            note_id: e.note_id,
            message: e.message,
            error: "conflict",
            expected_updated_at: e.expected_updated_at,
          },
          409,
        );
      }
      if (e && e.code === "TRANSITION_CONFLICT") {
        return json(
          {
            error_type: "transition_conflict",
            error: "transition_conflict",
            note_id: e.note_id,
            path: e.note_path ?? null,
            field: e.field,
            expected_from: e.expected_from,
            to: e.to,
            current: e.current ?? null,
            message: e.message,
          },
          409,
        );
      }
      if (e && e.code === "SCHEMA_VALIDATION") {
        return json({ error_type: "schema_validation", error: "schema_validation", violations: e.violations ?? [], message: e.message }, 422);
      }
      if (e && e.code === "PATH_CONFLICT") {
        return json({ error_type: "path_conflict", error: "path_conflict", path: e.path, message: e.message }, 409);
      }
      if (e && e.code === "INVALID_EXTENSION") {
        return json({ error_type: "invalid_extension", error: "invalid_extension", extension: e.extension, reason: e.reason, message: e.message }, 400);
      }
      throw e;
    }
  }

  // DELETE /notes/:idOrPath
  if (method === "DELETE") {
    const note = await resolveNote(store, idOrPath);
    if (!note) return json({ error: "Not found", error_type: "not_found" }, 404);
    if (!noteWithinTagScope(note, tagScope.allowed, tagScope.raw)) return json({ error: "Not found", error_type: "not_found" }, 404);
    await store.deleteNote(note.id);
    return json({ deleted: true, id: note.id });
  }

  return json({ error: "Method not allowed", error_type: "method_not_allowed" }, 405);
}

/** R2 object key for an attachment's vault-relative path (`<date>/<file>`). */
export function r2Key(vaultName: string, relativePath: string): string {
  return `vault-${vaultName}/attachments/${relativePath}`;
}
