/**
 * Tag scope for the cloud runtime: what a narrowed credential may see and change.
 *
 * Cloud has one kind of narrowed credential: a key held to some types by a grant the vault keeps (T-476, typed keys:
 * core docs/SPEC-1.0-grants.md §7.3, vault grants.ts). Its grant's types become the token's tag scope, exactly as the
 * box narrows a typed key (core packages/vault/src/auth.ts underGrant → `scoped_tags`), and the rules here are the
 * box's (core packages/vault/src/tag-scope.ts), minus `private_tags`, which Cloud vaults don't have:
 *
 *   - a record is visible when one of its tags is in scope: a granted type, a subtype of one (the hierarchy, read
 *     now), or a `/` sub-tag of one (`recipe/soup`);
 *   - a write must leave the record with a tag in scope, and may attach or detach only tags in scope;
 *   - a visible record's other tags are scrubbed from what the credential reads.
 *
 * A token that itself carries `permissions.scoped_tags` is still refused at auth (auth.ts): the scope comes from the
 * vault's own grant row, never from the token. And a narrowed credential reaches only the routes and tools this vault
 * opens to it (vault-do.ts `grantedRestGate`, mcp.ts); everything else answers {@link tagScopedVaultWideForbidden}.
 * Unscoped (`raw === null`) is every other credential: every helper is a passthrough for it.
 */
import type { Note, Store } from "@openparachute/core/src/types.js";
import { getTagExpansion } from "@openparachute/core/src/tag-hierarchy.js";

/**
 * Tag-scope context threaded through handlers. Both null = unscoped; `allowed` is the expanded scope (granted types,
 * their subtypes), `raw` the granted roots themselves.
 */
export type TagScopeCtx = { allowed: Set<string> | null; raw: string[] | null };

export const NO_TAG_SCOPE: TagScopeCtx = { allowed: null, raw: null };

/** The scope for `roots`, read from the vault's tag hierarchy now: each root and its subtypes. */
export function tagScopeFor(store: Store, roots: string[]): TagScopeCtx {
  const hierarchy = store.getTagHierarchy();
  const allowed = new Set<string>();
  for (const t of roots) for (const x of getTagExpansion(hierarchy, t, "subtypes")) allowed.add(x);
  for (const t of roots) allowed.add(t);
  return { allowed, raw: [...roots] };
}

/** Is a single tag visible under this scope: in the expanded set, or a `/` sub-tag of a root? */
export function tagVisibleInScope(tag: string, allowed: Set<string> | null, raw: string[] | null): boolean {
  if (raw === null) return true;
  if (allowed && allowed.has(tag)) return true;
  const root = tag.split("/")[0];
  return !!root && raw.includes(root);
}

/** A record is visible when one of its tags is. A record with no tags is never visible to a narrowed credential. */
export function noteWithinTagScope(
  note: { tags?: string[] },
  allowed: Set<string> | null,
  raw: string[] | null,
): boolean {
  if (raw === null) return true;
  for (const t of note.tags ?? []) if (tagVisibleInScope(t, allowed, raw)) return true;
  return false;
}

export function filterNotesByTagScope<T extends { tags?: string[] }>(
  notes: T[],
  allowed: Set<string> | null,
  raw: string[] | null,
): T[] {
  if (raw === null) return notes;
  return notes.filter((n) => noteWithinTagScope(n, allowed, raw)).map((n) => scrubNoteTagsByScope(n, allowed, raw));
}

/** A visible record's tags (and types) without the ones out of scope: their names are not this credential's to read. */
export function scrubNoteTagsByScope<T extends { tags?: string[]; types?: string[] }>(
  note: T,
  allowed: Set<string> | null,
  raw: string[] | null,
): T {
  if (raw === null || !note || !Array.isArray(note.tags)) return note;
  const tags = note.tags.filter((t) => tagVisibleInScope(t, allowed, raw));
  const types = Array.isArray(note.types) ? note.types.filter((t) => tagVisibleInScope(t, allowed, raw)) : undefined;
  if (tags.length === note.tags.length && (!types || types.length === note.types!.length)) return note;
  return { ...note, tags, ...(types ? { types } : {}) };
}

type LinkEnd = { tags?: string[] } | null | undefined;

/** Links whose both ends are visible, with each end's tags scrubbed (the box's rule). */
export function filterHydratedLinksByTagScope<T>(
  links: T[],
  allowed: Set<string> | null,
  raw: string[] | null,
): T[] {
  if (raw === null) return links;
  const visible = (end: LinkEnd) => !!end && noteWithinTagScope(end, allowed, raw);
  return links
    .filter((l) => {
      const link = l as unknown as { sourceNote?: LinkEnd; targetNote?: LinkEnd };
      return visible(link.sourceNote) && visible(link.targetNote);
    })
    .map((l) => {
      const link = l as unknown as { sourceNote?: { tags?: string[] }; targetNote?: { tags?: string[] } };
      return {
        ...link,
        ...(link.sourceNote ? { sourceNote: scrubNoteTagsByScope(link.sourceNote, allowed, raw) } : {}),
        ...(link.targetNote ? { targetNote: scrubNoteTagsByScope(link.targetNote, allowed, raw) } : {}),
      } as unknown as T;
    });
}

/**
 * May a write leave a record with `tags`, attaching `added` and detaching `removed`? The result must keep a tag in
 * scope, and every tag attached or detached must itself be in scope (detaching a hidden one would change what other
 * readers see, and checking only when present would tell the writer whether it is there). The box's rule.
 */
export function tagsWithinScope(
  tags: string[] | undefined,
  allowed: Set<string> | null,
  raw: string[] | null,
  added: string[] = tags ?? [],
  removed: string[] = [],
): boolean {
  if (raw === null) return true;
  const bare = (list: unknown) =>
    (Array.isArray(list) ? list : []).filter((t): t is string => typeof t === "string").map((t) => t.replace(/^#/, "")).filter((t) => t !== "");
  if ([...added, ...removed].some((t) => typeof t !== "string")) return false;
  for (const t of [...bare(added), ...bare(removed)]) if (!tagVisibleInScope(t, allowed, raw)) return false;
  return bare(tags).some((t) => tagVisibleInScope(t, allowed, raw));
}

export function tagScopeForbidden(raw: string[]): Response {
  return Response.json(
    {
      error: "Forbidden",
      error_type: "tag_scope_violation",
      message: `This key is held to: ${raw.join(", ")}. The record (or write) is outside that.`,
      scoped_tags: raw,
    },
    { status: 403 },
  );
}

/** The refusal for a route that acts on the whole vault, to a narrowed credential (the box's words and shape). */
export function tagScopedVaultWideForbidden(raw: string[]): Response {
  return Response.json(
    {
      error: "Forbidden",
      error_type: "tag_scope_violation",
      message: `This key is held to: ${raw.join(", ")}. This endpoint acts on the whole vault and needs a key with no such limit.`,
      scoped_tags: raw,
    },
    { status: 403 },
  );
}

/** Wikilink-expansion visibility predicate; undefined when unscoped (expansion is unchanged). */
export function buildExpandVisibility(
  allowed: Set<string> | null,
  raw: string[] | null,
): ((note: Note) => boolean) | undefined {
  if (raw === null) return undefined;
  return (note: Note) => noteWithinTagScope(note, allowed, raw);
}

/**
 * An update's `tags: {add, remove}` applied to a record's tags the way the store applies them (add, then remove, each
 * without a leading `#`): the tags it ends with, and what the write asks to attach and detach. Feed all three to
 * {@link tagsWithinScope}. The box's rule (core packages/vault/src/tag-scope.ts projectTagUpdate).
 */
export function projectTagUpdate(
  existing: string[] | undefined,
  add: unknown,
  remove: unknown,
): { projected: string[]; added: string[]; removed: string[] } {
  const bare = (v: unknown) =>
    (Array.isArray(v) ? v : []).filter((t): t is string => typeof t === "string").map((t) => t.replace(/^#/, "")).filter((t) => t !== "");
  const before = new Set(existing ?? []);
  const removed = new Set(bare(remove));
  const after = new Set([...before, ...bare(add)].filter((t) => !removed.has(t)));
  return { projected: [...after], added: [...new Set(bare(add))], removed: [...removed] };
}

/**
 * A narrowed credential's JSON answer, with every record in it scrubbed of the tags (and types) it can't see:
 * wherever the handler echoes a record (a read by id, a write's echo, a batch, links' ends), one place catches it.
 * Non-JSON and unscoped answers pass unchanged.
 */
/**
 * A visible record's `validation_status` without what names a type the reader can't see: a warning whose schema (or,
 * for a conflict, the schema it lost to) is hidden, and hidden names in `schemas`; undefined when nothing visible is
 * left (the record then reads as one with no schema). The box's rule (tag-scope.ts scrubValidationStatusByScope).
 */
export function scrubValidationStatusByScope<S extends { schemas?: string[]; warnings?: Array<{ schema?: string; loser_schema?: string }> }>(
  status: S | null | undefined,
  allowed: Set<string> | null,
  raw: string[] | null,
): S | undefined {
  if (!status || raw === null) return status ?? undefined;
  const visible = (t: unknown) => typeof t === "string" && tagVisibleInScope(t, allowed, raw);
  const schemas = (status.schemas ?? []).filter(visible);
  const warnings = (status.warnings ?? []).filter((w) => visible(w.schema) && (w.loser_schema === undefined || visible(w.loser_schema)));
  if (schemas.length === 0 && warnings.length === 0) return undefined;
  return { ...status, schemas, warnings };
}

export async function scrubResponseByScope(res: Response, scope: TagScopeCtx): Promise<Response> {
  if (scope.raw === null) return res;
  if (!(res.headers.get("content-type") ?? "").includes("application/json")) return res;
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers });
  }
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== "object") return v;
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(o)) out[k] = walk(x);
    if (out.validation_status && typeof out.validation_status === "object") {
      const v = scrubValidationStatusByScope(out.validation_status as { schemas?: string[]; warnings?: { schema?: string; loser_schema?: string }[] }, scope.allowed, scope.raw);
      if (v === undefined) delete out.validation_status;
      else out.validation_status = v;
    }
    return typeof out.id === "string" && Array.isArray(out.tags) ? scrubNoteTagsByScope(out as { tags?: string[]; types?: string[] }, scope.allowed, scope.raw) : out;
  };
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify(walk(body)), { status: res.status, statusText: res.statusText, headers });
}
