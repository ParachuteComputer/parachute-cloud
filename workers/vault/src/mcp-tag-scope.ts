/**
 * MCP for a typed key (T-476): the tools a key held to some types may use, each narrowed to them. A compact port of
 * the box's wrappers (core packages/vault/src/mcp-tools.ts applyTagScopeWrappers), for the five note tools the 0.9
 * record surface is built over (core mcp-surface.ts shapeRecordSurface), so `query-records`, `create-record`,
 * `update-record`, `delete-record` and `list-types` inherit the narrowing from their twins, as on a box.
 *
 * Deny by default: after shaping, a narrowed session lists only {@link NARROWED_TOOLS}; everything else acts on the
 * whole vault (vault-info's map, doctor, find-path's graph, the type and tag tools, migrate) and isn't offered.
 *
 * What each wrapper holds (the box's rules):
 *   - query-notes: a record by id or path, a `near` anchor, a history request: one it can't see is "not found", the
 *     same answer as a missing one; under a grant no version is visible (spec §4.1); a tag it can't see named in the
 *     query matches nothing; results keep only visible records, each with its hidden tags scrubbed; a rollup counts
 *     only visible records (the engine's own `aggregateVisibility`) and names only visible tag groups; warnings are
 *     dropped (core's did_you_mean reads the whole vault's names).
 *   - list-tags: only visible names; a hidden one asked for by name is "not found".
 *   - create-note: every record must carry a type in scope, and every type it names must be in scope (create on all).
 *   - update-note: the record must be visible; the tags it ends with keep one in scope, and every tag attached or
 *     detached is in scope.
 *   - delete-note: the record must be visible (`ids` is the engine's, resolved among visible records only).
 */
import type { McpToolDef } from "@openparachute/core/src/mcp.js";
import { resolveNote } from "@openparachute/core/src/mcp.js";
import { getNoteTags, type NoteVisible } from "@openparachute/core/src/notes.js";
import { mergeTypesIntoTags } from "@openparachute/core/src/tag-kind.js";
import type { Note, Store } from "@openparachute/core/src/types.js";
import {
  noteWithinTagScope,
  projectTagUpdate,
  scrubNoteTagsByScope,
  scrubValidationStatusByScope,
  filterHydratedLinksByTagScope,
  tagsWithinScope,
  tagVisibleInScope,
  type TagScopeCtx,
} from "./rest/tag-scope.js";

/** The tools a narrowed session lists (note tools and their 0.9 record twins, and the file tools). */
export const NARROWED_TOOLS: ReadonlySet<string> = new Set([
  "query-records", "create-record", "update-record", "delete-record", "list-types",
  "query-notes", "create-note", "update-note", "delete-note", "list-tags",
  "attachment-url", "read-attachment", "request-attachment-upload", "request-attachment-download",
]);

/** A query tag the key can't see becomes this: a name no record carries (the box's rule, vault#675). */
const OUT_OF_SCOPE_QUERY_TAG = "\u0000out-of-scope";

type Db = Parameters<typeof resolveNote>[0];

/** The engine's visibility predicate for a scope, with the per-tag rule its SQL arms use (core notes.ts NoteVisible). */
export function scopeVisibility(scope: TagScopeCtx): NoteVisible {
  const visible = ((note: Note) => noteWithinTagScope(note, scope.allowed, scope.raw)) as NoteVisible;
  visible.byTag = (tag: string) => ({ admits: tagVisibleInScope(tag, scope.allowed, scope.raw), denies: false });
  return visible;
}

/** By id: is the record visible under this scope? */
export function idVisibility(db: Db, scope: TagScopeCtx): (noteId: string) => boolean {
  return (noteId: string) => noteWithinTagScope({ tags: getNoteTags(db as Parameters<typeof getNoteTags>[0], noteId) }, scope.allowed, scope.raw);
}

function wrap(
  tools: McpToolDef[],
  name: string,
  wrapper: (orig: (params: Record<string, unknown>) => Promise<unknown>, params: Record<string, unknown>) => Promise<unknown>,
): void {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return;
  const orig = tool.execute;
  tool.execute = (params) => wrapper((p) => Promise.resolve(orig(p)), params);
}

/** Wrap the note tools for a session narrowed to `scope` (see the module note). `grant`: the session is a typed key's. */
export function applyScopeWrappers(tools: McpToolDef[], store: Store, scope: TagScopeCtx, grant: boolean): void {
  if (scope.raw === null) return;
  const { allowed, raw } = scope;
  const db = store.db as unknown as Db;
  const visible = (n: Note) => noteWithinTagScope(n, allowed, raw);
  const notFound = (id: unknown) => ({ error: "Note not found", error_type: "not_found", id: id ?? null });
  const forbidden = (msg: string) => ({
    error: "Forbidden",
    error_type: "tag_scope_violation",
    message: `${msg} (this key is held to: ${raw.join(", ")})`,
    scoped_tags: raw,
  });
  const resolveVisible = (ref: string): Note | null => {
    try {
      return resolveNote(db, ref, visible);
    } catch {
      // An ambiguous reference is never resolved for a narrowed session: its candidates could be hidden.
      return null;
    }
  };
  const scrub = (n: any): any => {
    if (n && Array.isArray(n.links)) n.links = filterHydratedLinksByTagScope(n.links, allowed, raw);
    if (n && Array.isArray(n.warnings)) delete n.warnings;
    if (n && n.validation_status) {
      const v = scrubValidationStatusByScope(n.validation_status, allowed, raw);
      if (v === undefined) delete n.validation_status;
      else n.validation_status = v;
    }
    return scrubNoteTagsByScope(n, allowed, raw);
  };
  const scrubWrite = (result: any): any => {
    if (!result || typeof result !== "object") return result;
    if (Array.isArray(result)) return result.map(scrub);
    if ("error" in result) return result;
    if (Array.isArray(result.notes)) return { ...result, notes: result.notes.map(scrub) };
    if ("id" in result && "tags" in result) return scrub(result);
    return result;
  };
  const scopeQueryTag = (v: unknown): unknown => {
    if (typeof v === "string") return tagVisibleInScope(v.replace(/^#/, ""), allowed, raw) ? v : OUT_OF_SCOPE_QUERY_TAG;
    if (Array.isArray(v)) return v.map(scopeQueryTag);
    return v;
  };

  wrap(tools, "query-notes", async (orig, params) => {
    const p = params as any;
    const historyRef = p?.versions?.note_id;
    if (typeof historyRef === "string") {
      if (!resolveVisible(historyRef)) return notFound(historyRef);
      if (grant) {
        const v = p.versions;
        if (v.version_ix !== undefined || v.import_ix !== undefined || v.origin !== undefined) return { error: "Version not found", error_type: "not_found", id: historyRef };
        return { versions: [], total: 0 };
      }
    }
    if (typeof p?.id === "string" && p.id && p.aggregate === undefined && !p.versions) {
      if (!resolveVisible(p.id)) return notFound(p.id);
    }
    if (typeof p?.near?.note_id === "string" && !resolveVisible(p.near.note_id)) {
      return { error: "Anchor note not found", error_type: "not_found", note_id: p.near.note_id };
    }
    let next: Record<string, unknown> = params;
    for (const key of ["tag", "type", "exclude_tags", "excludeTags", "exclude_tag"]) {
      if (p?.[key] === undefined) continue;
      const scoped = scopeQueryTag(p[key]);
      if (JSON.stringify(scoped) !== JSON.stringify(p[key])) next = { ...next, [key]: scoped };
    }
    const result: any = await orig(next);
    if (p?.aggregate && Array.isArray(result) && result.every((r: any) => r && typeof r === "object" && "group" in r && "value" in r && !("id" in r))) {
      return p.aggregate?.group_by === "tag" ? result.filter((r: any) => typeof r.group === "string" && tagVisibleInScope(r.group, allowed, raw)) : result;
    }
    if (result && typeof result === "object" && "versions" in result && Array.isArray(result.versions)) return { versions: [], total: 0 };
    if (Array.isArray(result)) return result.filter(visible).map(scrub);
    if (result && typeof result === "object" && Array.isArray(result.notes)) {
      return { notes: result.notes.filter(visible).map(scrub), ...("next_cursor" in result ? { next_cursor: result.next_cursor } : {}) };
    }
    if (result && typeof result === "object" && "id" in result && "tags" in result) {
      return visible(result) ? scrub(result) : notFound(p?.id);
    }
    return result;
  });

  wrap(tools, "list-tags", async (orig, params) => {
    const single = typeof (params as any).tag === "string" ? ((params as any).tag as string) : null;
    if (single !== null && !tagVisibleInScope(single.replace(/^#/, ""), allowed, raw)) {
      return { error: "Tag not found", error_type: "tag_not_found", tag: single };
    }
    const result: any = await orig(params);
    if (Array.isArray(result)) return result.filter((t: any) => typeof t?.name === "string" && tagVisibleInScope(t.name, allowed, raw));
    if (result && typeof result === "object" && result.error_type === "tag_not_found" && "did_you_mean" in result) {
      const { did_you_mean: _hidden, ...rest } = result;
      return rest;
    }
    return result;
  });

  wrap(tools, "create-note", async (orig, params) => {
    const items = Array.isArray((params as any).notes) ? (params as any).notes : [params];
    for (const rawItem of items) {
      const item = mergeTypesIntoTags(rawItem as Record<string, unknown>, "create") as any;
      const tags = Array.isArray(item.tags) ? (item.tags as string[]) : [];
      if (!tagsWithinScope(tags, allowed, raw)) return forbidden("create: a record must carry a type this key may write, and only those");
    }
    return scrubWrite(await orig(params));
  });

  wrap(tools, "update-note", async (orig, params) => {
    const items = Array.isArray((params as any).notes) ? (params as any).notes : [params];
    for (const rawItem of items) {
      const item = mergeTypesIntoTags(rawItem as Record<string, unknown>, "update") as any;
      const ref = item.id ?? item.note_id ?? item.path;
      if (typeof ref !== "string" || !ref) continue;
      const existing = resolveVisible(ref);
      if (!existing) return notFound(ref);
      const { projected, added, removed } = projectTagUpdate(existing.tags, item.tags?.add, item.tags?.remove);
      if (!tagsWithinScope(projected, allowed, raw, added, removed)) return forbidden("update: the record must keep a type this key may write, and change only those");
    }
    return scrubWrite(await orig(params));
  });

  wrap(tools, "delete-note", async (orig, params) => {
    const ref = (params as any).id ?? (params as any).note_id ?? (params as any).path;
    if (typeof ref === "string" && ref && !resolveVisible(ref)) return notFound(ref);
    return await orig(params);
  });
}
