/**
 * Skills over MCP on this door (T-476): the MCP Skills extension (`io.modelcontextprotocol/skills`, SEP-2640) on
 * 2026-07-28 connections, as a box serves it (parachute-core packages/vault/src/mcp-skills.ts + mcp-modern.ts). Claude
 * asks for skills only on a 2026-07-28 connection; a client lists names and descriptions, then reads a skill's
 * `SKILL.md`, and a file of it, when it needs them. Three sources, one list, in the box's order:
 *
 *   - `vault-guide` (generated): how to work with THIS vault, from this connection's projection.
 *   - `live-page` (written in core): how to build a live Claude artifact on this connector.
 *   - the vault's own: records of type `skill`, read through this connection's own `query-records`, so a key lists
 *     only the skill records it could read anyway (a typed key's scope included).
 *
 * The files come from the engine (core skill-files.ts), and each entry (digests, sizes, parsed frontmatter, the name
 * checks) from the MCP SDK's own `skillEntry`, the call a box makes: nothing here re-derives a skill. What this file
 * holds is the door's wiring, which the box keeps in its own door too: the two URI authorities, the listing order,
 * the read-back map, and the replies the SDK's SkillsExtension gives (transcribed from @modelcontextprotocol/server
 * 2.4.0 ext/skills, as mcp.ts transcribes the rest of the transport). Nothing is cached between requests: the set is
 * built on the first skills call of a request.
 */
import { skillEntry, type Skill } from "@modelcontextprotocol/server/ext/skills";
import type { McpToolDef } from "@openparachute/core/src/mcp.js";
import type { VaultProjection } from "@openparachute/core/src/vault-projection.js";
import { SKILL_TYPE } from "@openparachute/core/src/skills.js";
import {
  LIVE_PAGE_SKILL,
  MAX_FILES_PER_SKILL,
  MAX_VAULT_SKILLS,
  vaultGuideFiles,
  vaultSkills,
  type SkillRecordLike,
} from "@openparachute/core/src/skill-files.js";

/** The extension's id, as `server/discover` declares it. */
export const SKILLS_EXTENSION_ID = "io.modelcontextprotocol/skills";
/** The methods this file answers on a 2026-07-28 connection. */
export const SKILL_METHODS = new Set(["skills/list", "skills/get", "resources/list", "resources/templates/list", "resources/read"]);

/** URI authority for skills the server writes, and for skills the vault's records hold (the box's). */
const SERVER_PREFIX = "parachute";
const VAULT_PREFIX = "vault";
/** Skill records read per request: every skill and its files, at the limits a client reads. */
const MAX_SKILL_RECORDS = MAX_VAULT_SKILLS * (1 + MAX_FILES_PER_SKILL);
/** A skill's text moves with the vault's records, so a client keeps none of these replies (the SDK's default hint). */
const NO_CACHE = { ttlMs: 0, cacheScope: "private" } as const;

const MIME: Record<string, string> = {
  md: "text/markdown", txt: "text/plain", json: "application/json", csv: "text/csv", html: "text/html",
  yaml: "application/yaml", yml: "application/yaml", py: "text/x-python", js: "text/javascript", ts: "text/typescript",
};
function mimeTypeOf(uri: string): string {
  return MIME[uri.slice(uri.lastIndexOf(".") + 1).toLowerCase()] ?? "text/plain";
}

interface BuiltSkill {
  entry: Skill;
  files: Map<string, string>; // uri → text
}

export interface VaultSkillsInput {
  vaultName: string;
  /** This connection's projection (mcp.ts `projectionFor`). */
  projection: () => VaultProjection;
  /** This connection's `query-records`, or undefined when it can't see it. */
  queryRecords: McpToolDef | undefined;
}

/** A skills method's answer: a result, or a JSON-RPC error (`code`, `message`, optional `data`), as the SDK says it. */
export type SkillsReply = { result: Record<string, unknown> } | { error: { code: number; message: string; data?: unknown } };

const INVALID_PARAMS = -32602;

/** The skill methods over one vault for one request. Built on the first call, then reused. */
export function vaultSkillMethods(input: VaultSkillsInput): (method: string, params: Record<string, unknown> | undefined) => Promise<SkillsReply> {
  let built: Promise<BuiltSkill[]> | null = null;
  const all = () => (built ??= buildSkills(input));
  return async (method, params) => {
    const uri = params?.uri;
    switch (method) {
      case "skills/list":
        // The box's source answers one page (at most 100 vault skills plus its two) and ignores a cursor.
        return { result: { skills: (await all()).map((s) => s.entry), ...NO_CACHE } };
      case "skills/get": {
        if (typeof uri !== "string") return invalid(`Invalid params for skills/get: uri: Invalid input: expected string, received ${kindOf(uri)}`);
        const skill = (await all()).find((s) => s.entry.uri === uri)?.entry;
        if (!skill) return invalid(`No skill is served at ${uri}`);
        return { result: { skill, ...NO_CACHE } };
      }
      case "resources/list":
        // Each SKILL.md also appears here, so a client without the extension can still find and read them.
        return {
          result: {
            resources: (await all()).map((s) => ({
              uri: s.entry.uri,
              name: s.entry.frontmatter.name,
              description: s.entry.frontmatter.description,
              mimeType: "text/markdown",
            })),
            ...NO_CACHE,
          },
        };
      case "resources/templates/list":
        return { result: { resourceTemplates: [{ name: SKILLS_EXTENSION_ID, uriTemplate: "skill://{+path}" }], ...NO_CACHE } };
      case "resources/read": {
        if (typeof uri !== "string") return invalid(`Invalid params for resources/read: uri: Invalid input: expected string, received ${kindOf(uri)}`);
        for (const s of await all()) {
          const text = s.files.get(uri);
          if (text !== undefined) return { result: { contents: [{ uri, mimeType: mimeTypeOf(uri), text }], ...NO_CACHE } };
        }
        return { error: { code: INVALID_PARAMS, message: `Resource not found: ${uri}`, data: { uri } } };
      }
      default:
        throw new Error(`mcp-skills: not a skills method: ${method}`);
    }
  };
}

function invalid(message: string): SkillsReply {
  return { error: { code: INVALID_PARAMS, message } };
}
function kindOf(v: unknown): string {
  return v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
}

async function buildSkills(input: VaultSkillsInput): Promise<BuiltSkill[]> {
  const out: BuiltSkill[] = [];
  const taken = new Set<string>();
  const add = async (prefix: string, name: string, files: Record<string, string>) => {
    try {
      const entry = await skillEntry(`${prefix}/${name}`, files);
      const byUri = new Map<string, string>();
      for (const [rel, text] of Object.entries(files)) byUri.set(`skill://${prefix}/${name}/${rel}`, text);
      out.push({ entry, files: byUri });
      taken.add(name);
    } catch {
      // A skill the SDK won't serve (a pasted SKILL.md whose name breaks the rules) is left out, as on a box. No log:
      // the reason names the vault's own record, and this door logs only server-defined words.
    }
  };

  await add(SERVER_PREFIX, "vault-guide", vaultGuideFiles(input.vaultName, input.projection()));
  await add(SERVER_PREFIX, "live-page", { "SKILL.md": LIVE_PAGE_SKILL });
  for (const skill of vaultSkills(await readSkillRecords(input.queryRecords))) {
    if (taken.has(skill.name)) continue; // a vault skill named like one already served
    await add(VAULT_PREFIX, skill.name, skill.files);
  }
  return out;
}

/** This connection's skill records (and records of `skill` subtypes, which vaultSkills leaves out), up to the limit. */
async function readSkillRecords(tool: McpToolDef | undefined): Promise<SkillRecordLike[]> {
  if (!tool) return [];
  const raw = (await tool.execute({ type: SKILL_TYPE, include_body: true, include_fields: true, limit: MAX_SKILL_RECORDS + 1 })) as unknown;
  const list = (Array.isArray(raw) ? raw : (raw as { records?: unknown[] })?.records ?? []) as SkillRecordLike[];
  return list.slice(0, MAX_SKILL_RECORDS);
}
