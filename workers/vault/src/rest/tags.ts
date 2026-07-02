/**
 * Tags + find-path REST surface. Ported from parachute-vault/src/routes.ts
 * (handleTags / handleFindPath). Read-only tag-scope checks collapse to
 * passthrough (cloud v1 is unscoped); the local-token-reference guards become
 * no-ops (cloud tokens live in the Identity Worker, not the vault DB — see
 * ./shims.ts). Everything else is the shared wire contract.
 */
import type { Store } from "@openparachute/core/src/types.js";
import { stripTagHash } from "@openparachute/core/src/tag-hierarchy.js";
import * as tagSchemaOps from "@openparachute/core/src/tag-schemas.js";
import { IndexedFieldError } from "@openparachute/core/src/indexed-fields.js";
import { buildVaultProjection, resolveTagInheritance } from "@openparachute/core/src/vault-projection.js";
import { loadSchemaConfig } from "@openparachute/core/src/schema-defaults.js";
import * as linkOps from "@openparachute/core/src/links.js";
import {
  json,
  parseBool,
  parseQuery,
  parseInt10,
  resolveNote,
  NotFoundError,
  ambiguousPathResponse,
  type TagScopeCtx,
  NO_TAG_SCOPE,
} from "./parse.js";
import { noteWithinTagScope, tagScopeForbidden } from "./tag-scope.js";
import { findTokensReferencingTag } from "./shims.js";

export async function handleTags(
  req: Request,
  store: Store,
  subpath = "",
  tagScope: TagScopeCtx = NO_TAG_SCOPE,
): Promise<Response> {
  const url = new URL(req.url);

  // GET /tags — list all, or single tag detail via ?tag=
  if (req.method === "GET" && subpath === "") {
    const singleTag = parseQuery(url, "tag");
    if (singleTag) {
      if (tagScope.allowed && !tagScope.allowed.has(singleTag)) {
        return json({ error: "Tag not found", tag: singleTag }, 404);
      }
      const allTags = await store.listTags();
      const found = allTags.find((t) => t.name === singleTag);
      const record = await store.getTagRecord(singleTag);
      return json({
        name: singleTag,
        count: found?.count ?? 0,
        description: record?.description ?? null,
        fields: record?.fields ?? null,
        relationships: record?.relationships ?? null,
        parent_names: record?.parent_names ?? null,
        created_at: record?.created_at ?? null,
        updated_at: record?.updated_at ?? null,
      });
    }

    const tags = await store.listTags();
    const filtered = tagScope.allowed ? tags.filter((t) => tagScope.allowed!.has(t.name)) : tags;
    if (parseBool(parseQuery(url, "include_schema"), false)) {
      const records = new Map((await store.listTagRecords()).map((r) => [r.tag, r] as const));
      return json(filtered.map((t) => {
        const r = records.get(t.name);
        return {
          ...t,
          description: r?.description ?? null,
          fields: r?.fields ?? null,
          relationships: r?.relationships ?? null,
          parent_names: r?.parent_names ?? null,
          created_at: r?.created_at ?? null,
          updated_at: r?.updated_at ?? null,
        };
      }));
    }
    return json(filtered);
  }

  // POST /tags/merge
  if (subpath === "/merge") {
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
    const body = (await req.json().catch(() => null)) as { sources?: unknown; target?: unknown } | null;
    if (!body) return json({ error: "Invalid JSON body" }, 400);
    const sources = body.sources;
    const target = body.target;
    if (!Array.isArray(sources) || !sources.every((s) => typeof s === "string" && s.length > 0)) {
      return json({ error: "sources must be a non-empty array of strings" }, 400);
    }
    if (typeof target !== "string" || target.length === 0) {
      return json({ error: "target must be a non-empty string" }, 400);
    }
    if (tagScope.allowed) {
      for (const t of [...sources, target]) {
        if (!tagScope.allowed.has(t)) return tagScopeForbidden(tagScope.raw ?? []);
      }
    }
    const referenced: { source: string; tokens: { id: string; label: string }[] }[] = [];
    const db = store.db;
    for (const src of sources) {
      const tokens = findTokensReferencingTag(db, src as string);
      if (tokens.length > 0) referenced.push({ source: src as string, tokens });
    }
    if (referenced.length > 0) {
      return json(
        {
          error: "TagInUseByTokens",
          error_type: "tag_in_use_by_tokens",
          message: `Cannot merge: ${referenced.length} source tag(s) referenced by tag-scoped token(s); revoke or re-mint them first.`,
          referenced_by: referenced,
        },
        409,
      );
    }
    const result = await store.mergeTags(sources, target);
    return json(result);
  }

  // POST /tags/:name/rename
  const renameMatch = subpath.match(/^\/([^/]+)\/rename$/);
  if (renameMatch) {
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
    const oldName = decodeURIComponent(renameMatch[1]!);
    const body = (await req.json().catch(() => null)) as { new_name?: unknown } | null;
    if (!body) return json({ error: "Invalid JSON body" }, 400);
    const newName = body.new_name;
    if (typeof newName !== "string" || newName.length === 0) {
      return json({ error: "new_name must be a non-empty string" }, 400);
    }
    if (tagScope.allowed && (!tagScope.allowed.has(oldName) || !tagScope.allowed.has(newName))) {
      return tagScopeForbidden(tagScope.raw ?? []);
    }
    const result = await store.renameTag(oldName, newName);
    if ("error" in result) {
      if (result.error === "not_found") return json({ error: "not_found", tag: oldName }, 404);
      if (result.error === "target_exists") {
        return json(
          {
            error: "target_exists",
            target: newName,
            conflicting: result.conflicting,
            message: "Target tag (or one of its sub-tags) already exists; use POST /api/tags/merge to combine them.",
          },
          409,
        );
      }
    }
    return json(result);
  }

  // POST /tags/:name/conformance
  const conformanceMatch = subpath.match(/^\/([^/]+)\/conformance$/);
  if (conformanceMatch) {
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
    const cTag = decodeURIComponent(conformanceMatch[1]!);
    if (tagScope.allowed && !tagScope.allowed.has(cTag)) return json({ error: "Tag not found", tag: cTag }, 404);
    const body = (await req.json().catch(() => null)) as { fields?: Record<string, unknown> | null } | null;
    if (!body) return json({ error: "Invalid JSON body" }, 400);
    const proposed: Record<string, tagSchemaOps.TagFieldSchema> = {};
    if (body.fields && typeof body.fields === "object" && !Array.isArray(body.fields)) {
      for (const [k, v] of Object.entries(body.fields)) {
        if (v && typeof v === "object" && !Array.isArray(v)) proposed[k] = v as tagSchemaOps.TagFieldSchema;
      }
    }
    const report = await store.countTagConformance(cTag, proposed);
    return json(report);
  }

  // GET /tags/:name/effective
  const effectiveMatch = subpath.match(/^\/([^/]+)\/effective$/);
  if (effectiveMatch) {
    if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
    const eTag = decodeURIComponent(effectiveMatch[1]!);
    if (tagScope.allowed && !tagScope.allowed.has(eTag)) return json({ error: "Tag not found", tag: eTag }, 404);
    const projection = buildVaultProjection(store.db);
    const record = await store.getTagRecord(eTag);
    const resolved = loadSchemaConfig(store.db);
    const { effective_parents, effective_fields } = resolveTagInheritance(resolved, eTag);
    return json({
      name: eTag,
      parents: record?.parent_names ?? [],
      effective_parents,
      fields: record?.fields ?? null,
      effective_fields,
      indexed_fields: projection.indexed_fields,
    });
  }

  const nameMatch = subpath.match(/^\/([^/]+)$/);
  if (!nameMatch) return json({ error: "Not found" }, 404);
  const tagName = decodeURIComponent(nameMatch[1]!);

  // GET /tags/:name
  if (req.method === "GET") {
    if (tagScope.allowed && !tagScope.allowed.has(tagName)) return json({ error: "Tag not found", tag: tagName }, 404);
    const allTags = await store.listTags();
    const found = allTags.find((t) => t.name === tagName);
    const record = await store.getTagRecord(tagName);
    return json({
      name: tagName,
      count: found?.count ?? 0,
      description: record?.description ?? null,
      fields: record?.fields ?? null,
      relationships: record?.relationships ?? null,
      parent_names: record?.parent_names ?? null,
      created_at: record?.created_at ?? null,
      updated_at: record?.updated_at ?? null,
    });
  }

  // PUT /tags/:name
  if (req.method === "PUT") {
    const putTagName = stripTagHash(tagName);
    if (tagScope.allowed && !tagScope.allowed.has(putTagName)) return tagScopeForbidden(tagScope.raw ?? []);
    const body = (await req.json()) as {
      description?: string | null;
      fields?: Record<string, unknown> | null;
      relationships?: Record<string, unknown> | null;
      parent_names?: unknown;
      replace_fields?: unknown;
    };
    const replaceFields = body.replace_fields === true;

    let relationshipsPatch: tagSchemaOps.TagRelationshipMap | null | undefined;
    if (body.relationships === null) {
      relationshipsPatch = null;
    } else if (body.relationships !== undefined) {
      try {
        relationshipsPatch = tagSchemaOps.validateRelationships(body.relationships);
      } catch (err) {
        return json({ error: (err as Error).message, error_type: "invalid_relationships" }, 400);
      }
    }

    let parentNamesPatch: string[] | null | undefined;
    if (body.parent_names === null) {
      parentNamesPatch = null;
    } else if (body.parent_names !== undefined) {
      if (!Array.isArray(body.parent_names)) {
        return json({ error: "parent_names must be an array of tag names" }, 400);
      }
      const cleaned = (body.parent_names as unknown[]).filter((p): p is string => typeof p === "string" && p.length > 0);
      parentNamesPatch = cleaned.length > 0 ? cleaned : null;
    }

    let fieldsPatch: Record<string, tagSchemaOps.TagFieldSchema> | null | undefined;
    if (body.fields === null) {
      fieldsPatch = null;
    } else if (body.fields !== undefined) {
      if (replaceFields) {
        const full = body.fields as Record<string, tagSchemaOps.TagFieldSchema>;
        fieldsPatch = Object.keys(full).length > 0 ? full : null;
      } else {
        const existing = await store.getTagSchema(putTagName);
        const merged: Record<string, tagSchemaOps.TagFieldSchema> = {
          ...(existing?.fields ?? {}),
          ...(body.fields as Record<string, tagSchemaOps.TagFieldSchema>),
        };
        fieldsPatch = Object.keys(merged).length > 0 ? merged : null;
      }
    }

    let result;
    try {
      result = await store.upsertTagRecord(putTagName, {
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(fieldsPatch !== undefined ? { fields: fieldsPatch } : {}),
        ...(relationshipsPatch !== undefined ? { relationships: relationshipsPatch } : {}),
        ...(parentNamesPatch !== undefined ? { parent_names: parentNamesPatch } : {}),
      });
    } catch (err) {
      if (err instanceof IndexedFieldError) {
        return json({ error: err.message, error_type: "invalid_indexed_field" }, 400);
      }
      throw err;
    }
    return json(result);
  }

  // DELETE /tags/:name
  if (req.method === "DELETE") {
    if (tagScope.allowed && !tagScope.allowed.has(tagName)) return tagScopeForbidden(tagScope.raw ?? []);
    const referenced_by = findTokensReferencingTag(store.db, tagName);
    if (referenced_by.length > 0) {
      return json(
        {
          error: "TagInUseByTokens",
          error_type: "tag_in_use_by_tokens",
          message: `Tag "${tagName}" is referenced by ${referenced_by.length} tag-scoped token(s); revoke or re-mint them before deleting.`,
          tag: tagName,
          referenced_by,
        },
        409,
      );
    }
    return json(await store.deleteTag(tagName));
  }

  return json({ error: "Method not allowed" }, 405);
}

export async function handleFindPath(
  req: Request,
  store: Store,
  tagScope: TagScopeCtx = NO_TAG_SCOPE,
): Promise<Response> {
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const url = new URL(req.url);
  const source = parseQuery(url, "source");
  const target = parseQuery(url, "target");
  if (!source || !target) return json({ error: "source and target parameters are required" }, 400);

  const db = store.db;
  try {
    const sourceNote = await resolveNote(store, source);
    if (!sourceNote) return json({ error: `Note not found: "${source}"` }, 404);
    if (!noteWithinTagScope(sourceNote, tagScope.allowed, tagScope.raw)) return json({ error: `Note not found: "${source}"` }, 404);
    const targetNote = await resolveNote(store, target);
    if (!targetNote) return json({ error: `Note not found: "${target}"` }, 404);
    if (!noteWithinTagScope(targetNote, tagScope.allowed, tagScope.raw)) return json({ error: `Note not found: "${target}"` }, 404);
    const maxDepth = Math.min(parseInt10(parseQuery(url, "max_depth")) ?? 5, 10);

    const result = linkOps.findPath(db, sourceNote.id, targetNote.id, { max_depth: maxDepth });
    if (result && tagScope.allowed) {
      for (const id of result.path) {
        const hop = await store.getNote(id);
        if (!hop || !noteWithinTagScope(hop, tagScope.allowed, tagScope.raw)) return json(null);
      }
    }
    return json(result);
  } catch (e: any) {
    if (e instanceof NotFoundError) return json({ error: e.message }, 404);
    const ambig = ambiguousPathResponse(e);
    if (ambig) return ambig;
    throw e;
  }
}
