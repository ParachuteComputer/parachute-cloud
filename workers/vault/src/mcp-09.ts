/**
 * The 0.9 tool shape on the cloud door (door/0.9, T-430): the record tools, the
 * eleven tools, the old note tools as working aliases, and unknown-parameter
 * teaching. A port of the box door's shaping in parachute-core
 * `packages/vault/src/mcp-tools.ts` at the pinned commit (applyElevenTools,
 * byToolOrder, applyRecordWordsToVaultInfo, applyParamTeaching,
 * withParamWarnings), so an agent sees the same tools/list on box and cloud.
 * Every table it reads (NEW_TOOLS, TOOL_ALIASES, TOOL_ORDER, RECORD_TOOL_NAMES,
 * the param references) and the record translator itself (addRecordTools) come
 * from the engine, so only the wiring is copied. It should move into the engine
 * beside them (audit L1: one copy, like the live matcher in T-421).
 *
 * Differences from the box, on purpose:
 *   - no `manage-token`/`manage-keys`: cloud has no in-vault token tool (keys are
 *     minted by the identity worker, `/account/keys`);
 *   - name use is counted by the DO's health counters (each call's subject is
 *     `mcp:<tool>`, old names included), not a run/deprecations.json file;
 *   - an unknown parameter leaves no log line: the counted health outcome and the
 *     answer's `warnings` are its trace.
 */
import type { McpToolDef } from "@openparachute/core/src/mcp.js";
import { MCP_TOOL_REFERENCE, acceptedParams } from "@openparachute/core/src/mcp-manifest.js";
import {
  addRecordTools,
  NOTE_TOOL_NAMES,
  RECORD_TOOL_NAMES,
  recordParamNames,
  recordSchema,
  recordWords,
} from "@openparachute/core/src/mcp-records.js";
import {
  aliasDescription,
  nestedParamProblem,
  NEW_TOOLS,
  REFUSES_UNKNOWN_PARAMS,
  SHORT_TOOLS,
  TOOL_ALIASES,
  TOOL_ORDER,
  unknownParams,
  type ParamProblem,
} from "@openparachute/core/src/mcp-short.js";
import { hasScopeForVault, type AuthResult } from "./auth.js";

export { recordWords };

const VERB_RANK: Record<string, number> = { read: 0, write: 1, admin: 2 };

/** Core's tools (vault-info already overridden by the door) → the 0.9 surface, in tools/list order. */
export function shape09(tools: McpToolDef[], vaultName: string, auth: AuthResult): McpToolDef[] {
  const shaped = byToolOrder(addRecordTools(applyElevenTools(tools, vaultName, auth)));
  applyRecordWordsToVaultInfo(shaped);
  applyParamTeaching(shaped);
  return shaped;
}

/**
 * `vault-info {help}` for a tool: its full reference (the long text and every
 * parameter), which the short tools/list descriptions point to. The new tools
 * answer with each action's own reference.
 */
export function toolHelp(name: string): Record<string, unknown> {
  const spec = NEW_TOOLS[name];
  if (spec) {
    return {
      tool: name,
      description: spec.description,
      parameters: spec.inputSchema,
      actions: Object.fromEntries(
        Object.entries(spec.folds).map(([action, old]) => [action, { replaces: old, parameters: MCP_TOOL_REFERENCE.find((e) => e.name === old)?.inputSchema }]),
      ),
    };
  }
  const ref = MCP_TOOL_REFERENCE.find((e) => e.name === name);
  if (!ref) {
    throw Object.assign(new Error(`No tool named "${name}": tools/list names the tools this key can use.`), {
      error_type: "unknown_tool",
      field: "help",
      hint: "pass one of the tool names",
    });
  }
  return { tool: ref.name, description: ref.description, parameters: ref.inputSchema };
}

/** manage-types and attachment-url, built from the tools they fold; find-path folded into query-notes; aliases marked. */
function applyElevenTools(tools: McpToolDef[], vaultName: string, auth: AuthResult): McpToolDef[] {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const out: McpToolDef[] = [];

  for (const [name, spec] of Object.entries(NEW_TOOLS)) {
    const folded = Object.values(spec.folds).map((n) => byName.get(n));
    if (folded.some((t) => !t)) continue;
    const actions = Object.keys(spec.folds);
    out.push({
      name,
      description: spec.description,
      inputSchema: spec.inputSchema,
      // The least any action needs; each action re-checks its own verb below.
      requiredVerb: folded.map((t) => t!.requiredVerb ?? "write").sort((a, b) => VERB_RANK[a]! - VERB_RANK[b]!)[0]!,
      execute: async (params) => {
        const action = (params.action ?? (name === "manage-types" ? "update" : undefined)) as string | undefined;
        const target = action ? byName.get(spec.folds[action] ?? "") : undefined;
        if (!target) {
          throw Object.assign(new Error(`${name} needs \`action\`: ${actions.join(", ")}.`), {
            error_type: "unknown_parameter",
            field: "action",
            hint: `one of ${actions.join(", ")}`,
          });
        }
        const verb = target.requiredVerb ?? "write";
        if (!hasScopeForVault(auth.scopes, vaultName, verb)) {
          throw new Error(`Forbidden: ${name} {action: "${action}"} needs the 'vault:${vaultName}:${verb}' scope.`);
        }
        const { action: _drop, ...rest } = params;
        if (name === "attachment-url" && rest.record !== undefined) {
          if (rest.note !== undefined) {
            throw Object.assign(new Error("attachment-url: pass `record` or `note`, not both (`note` is its old name)."), {
              error_type: "invalid_query",
              field: "record",
              hint: "use record",
            });
          }
          const { record, ...others } = rest;
          return target.execute({ ...others, note: record });
        }
        return target.execute(rest);
      },
    });
  }

  const query = byName.get("query-notes");
  const findPath = byName.get("find-path");
  if (query && findPath) {
    const execute = query.execute;
    query.execute = async (params) => {
      if (params.path_between === undefined) return execute(params);
      const pb = params.path_between as Record<string, unknown> | null;
      if (!pb || typeof pb !== "object" || Array.isArray(pb)) {
        throw Object.assign(new Error("path_between takes {source, target, max_depth?}."), { error_type: "invalid_query", field: "path_between" });
      }
      return findPath.execute(pb);
    };
  }

  for (const t of tools) {
    if (!(t.name in TOOL_ALIASES)) {
      out.push(t);
      continue;
    }
    const execute = t.execute;
    const use = TOOL_ALIASES[t.name]!;
    out.push({
      ...t,
      description: aliasDescription(t.name),
      execute: async (params) => {
        const result = await execute(params);
        if (result && typeof result === "object" && !Array.isArray(result)) {
          return { ...(result as Record<string, unknown>), deprecation: { tool: t.name, use, removed_in: "1.0" } };
        }
        return result;
      },
    });
  }
  return out;
}

/** tools/list's order: TOOL_ORDER, then anything it doesn't name. */
function byToolOrder(tools: McpToolDef[]): McpToolDef[] {
  const rank = (n: string) => {
    const i = TOOL_ORDER.indexOf(n);
    return i === -1 ? TOOL_ORDER.length : i;
  };
  return tools.sort((a, b) => rank(a.name) - rank(b.name));
}

/** vault-info in record words: `help` for a record tool, and the query hints. */
function applyRecordWordsToVaultInfo(tools: McpToolDef[]): void {
  const info = tools.find((t) => t.name === "vault-info");
  if (!info) return;
  const execute = info.execute;
  info.execute = async (params) => {
    const help = params?.help;
    const noteTool = typeof help === "string" ? NOTE_TOOL_NAMES[help] : undefined;
    if (noteTool) {
      const r = (await execute({ ...params, help: noteTool })) as { description?: string; parameters?: Record<string, unknown> };
      return { tool: help, description: recordWords(r.description ?? ""), parameters: recordSchema(noteTool, r.parameters ?? {}) };
    }
    const r = await execute(params);
    if (typeof help === "string" && RECORD_TOOL_NAMES[help] && r && typeof r === "object") {
      return { ...(r as Record<string, unknown>), deprecation: { tool: help, use: RECORD_TOOL_NAMES[help], removed_in: "1.0" } };
    }
    if (r && typeof r === "object" && Array.isArray((r as { query_hints?: unknown }).query_hints)) {
      const o = r as { query_hints: unknown[] };
      return { ...o, query_hints: o.query_hints.map((h) => (typeof h === "string" ? recordWords(h) : h)) };
    }
    return r;
  };
}

/** Every parameter a core tool takes: its full reference schema and the short schema it advertises. */
function takes(name: string): string[] {
  return [...new Set([...(acceptedParams(name) ?? []), ...Object.keys((SHORT_TOOLS[name]?.inputSchema as { properties?: object })?.properties ?? {})])];
}

/**
 * Unknown parameters: refused before anything runs on the tools 0.9 adds
 * (REFUSES_UNKNOWN_PARAMS), ignored with a `warnings` entry on every name a 0.8
 * client can call (box: mcp-tools.ts applyParamTeaching).
 */
function applyParamTeaching(tools: McpToolDef[]): void {
  for (const tool of tools) {
    const folds = NEW_TOOLS[tool.name]?.folds;
    const noteTool = NOTE_TOOL_NAMES[tool.name];
    const reference = noteTool
      ? recordParamNames(tool.name, takes(noteTool))
      : folds
        ? ["action", ...Object.values(folds).flatMap(takes), ...(tool.name === "attachment-url" ? ["record"] : [])]
        : RECORD_TOOL_NAMES[tool.name]
          ? takes(tool.name)
          : acceptedParams(tool.name);
    if (!reference) continue;
    const accepted = [...new Set([...reference, ...Object.keys((tool.inputSchema as { properties?: object }).properties ?? {})])];
    const perAction = folds
      ? Object.fromEntries(Object.entries(folds).map(([a, n]) => [a, ["action", ...takes(n), ...(n === "request-attachment-upload" ? ["record"] : [])]]))
      : undefined;
    const acceptedFor = (params: Record<string, unknown>) => {
      const action = params.action ?? (tool.name === "manage-types" ? "update" : undefined);
      return (typeof action === "string" && perAction?.[action]) || accepted;
    };
    const execute = tool.execute;
    tool.execute = async (params) => {
      const nested = nestedParamProblem(tool.name, params ?? {});
      if (nested) throw Object.assign(new Error(nested.message), nested);
      const refuses = REFUSES_UNKNOWN_PARAMS.has(tool.name);
      const unknown = unknownParams(tool.name, params ?? {}, acceptedFor(params ?? {}), refuses);
      if (unknown.length === 0) return execute(params);
      if (refuses) {
        const [first] = unknown;
        const message =
          unknown.length === 1
            ? first!.message
            : `${unknown.map((u) => u.message.replace(/ Every parameter:.*$/, "")).join(" ")} Every parameter: vault-info {help: "${tool.name}"}.`;
        throw Object.assign(new Error(message), { error_type: "unknown_parameter", field: first!.field, hint: first!.hint });
      }
      let result: unknown;
      try {
        result = await execute(params);
      } catch (err) {
        try {
          if (err instanceof Error) err.message += ` (Also: ${unknown.map((u) => u.message.replace(/ Every parameter:.*$/, "")).join(" ")})`;
        } catch {} // a frozen error keeps its own message
        throw err;
      }
      return withParamWarnings(tool.name, result, unknown);
    };
  }
}

function withParamWarnings(tool: string, result: unknown, unknown: ParamProblem[]): unknown {
  const warnings = unknown.map((u) => ({ code: u.error_type, message: u.message, field: u.field, hint: u.hint }));
  if (tool === "query-notes" && Array.isArray(result)) return { notes: result, warnings };
  if (tool === "query-records" && Array.isArray(result)) return { records: result, warnings };
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const r = result as Record<string, unknown>;
  return { ...r, warnings: [...(Array.isArray(r.warnings) ? r.warnings : []), ...warnings] };
}
