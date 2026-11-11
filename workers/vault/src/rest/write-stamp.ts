/**
 * The write stamp's on-behalf-of rule at the cloud vault worker (Parachute 0.9.1, T-446): the door glue around the
 * engine's own rule (core write-stamp.ts `resolveBy`), ported from the box (core packages/vault/src routing.ts
 * `restWriteStamp`, mcp-tools.ts `applyOnBehalf`) so both doors answer alike.
 *
 * A key the vault's owner let write on behalf of others (`permissions.acts_for`, auth.ts) may name who a write is for:
 * REST `Parachute-On-Behalf-Of`, MCP `on_behalf_of` on the write tools. The write is stamped `by <prefix>:<id>`, the
 * prefix from the token, only the id from the request; `via` stays the key, from the token. Without the grant a
 * supplied value is refused (`on_behalf_not_allowed`), never ignored, and on a route or tool that records no writer it
 * is refused too (`on_behalf_not_recorded`). Checked before anything runs, so a refused request writes nothing.
 * On-behalf-of never opens access: the call runs with the token's own scopes.
 */
import { ON_BEHALF_HEADER, ON_BEHALF_PARAM, resolveBy } from "@openparachute/core/src/write-stamp.js";
import type { McpToolDef } from "@openparachute/core/src/mcp.js";
import type { AuthResult } from "../auth.js";

/**
 * REST routes whose writes carry the write stamp: everything under /notes (/api/records arrives here rewritten as
 * /notes), except a note's attachments, history erases and a transcription retry (they record no writer), and a tag
 * rename (it rewrites notes). A read carries nothing to stamp. `apiPath` is the path under /api.
 */
function stampsWriter(method: string, apiPath: string): boolean {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return true;
  if (/^\/(notes|records)(\/|$|\?)/.test(apiPath)) return !/^\/(notes|records)\/[^/]+\/(attachments|versions|retry-transcription)(\/|$)/.test(apiPath);
  return /^\/(tags|types)\/[^/]+\/rename$/.test(apiPath);
}

/** The "by" a REST request writes with, or the refusal. */
export function restWriteStamp(req: Request, apiPath: string, auth: AuthResult): { by: string | null } | { refusal: Response } {
  const supplied = req.headers.get(ON_BEHALF_HEADER) ?? undefined;
  const r = resolveBy(supplied, auth.acts_for ?? null, auth.actor, "rest");
  const refuse = (status: number, body: Record<string, unknown>) => ({ refusal: Response.json({ error: body.message, ...body }, { status }) });
  if ("refusal" in r) return refuse(r.refusal.status, { ...r.refusal });
  if (supplied !== undefined && !stampsWriter(req.method, apiPath)) {
    return refuse(400, {
      error_type: "on_behalf_not_recorded",
      field: ON_BEHALF_HEADER,
      message: `${req.method} /api${apiPath} records no writer, so ${ON_BEHALF_HEADER} would be dropped. Nothing was written. Send it on record writes (create, change, delete, batch, restore) only.`,
      hint: "drop the header on this call",
    });
  }
  return r;
}

/** The MCP endpoint never reads the REST header, so it is refused rather than dropped (the box's dispatchScopedMcp). */
export function mcpHeaderRefusal(req: Request): Response | null {
  if (!req.headers.has(ON_BEHALF_HEADER)) return null;
  return Response.json({
    error: `${ON_BEHALF_HEADER} is the REST header; on MCP, pass on_behalf_of on the write tool (shown to a key the vault's owner let write on behalf of others). Nothing was done.`,
    error_type: "on_behalf_not_recorded",
    field: ON_BEHALF_HEADER,
  }, { status: 400 });
}

/** The MCP tools whose writes carry the write stamp, by the action that writes (manage-types: only rename does). */
function toolStampsWriter(tool: string, params: Record<string, unknown>): boolean {
  if (["create-note", "update-note", "delete-note", "create-record", "update-record", "delete-record", "rename-tag"].includes(tool)) return true;
  return tool === "manage-types" && params.action === "rename";
}
const STAMP_TOOLS = ["create-note", "update-note", "delete-note", "create-record", "update-record", "delete-record", "rename-tag", "manage-types"];

/**
 * The write stamp on MCP. A key with the owner's on-behalf-of permission sees an `on_behalf_of` parameter on the
 * write tools; every other session never sees it, and a supplied one is refused before anything runs, on every tool.
 * The call runs on the same tools built for that "by" (`withBy`: the engine reads its stamp once, at build), with
 * the token's own scope.
 */
export function applyOnBehalf(tools: McpToolDef[], auth: AuthResult, withBy: (by: string) => McpToolDef[]): void {
  const actsFor = auth.acts_for ?? null;
  for (const tool of tools) {
    if (actsFor !== null && STAMP_TOOLS.includes(tool.name)) {
      const schema = tool.inputSchema as { properties?: Record<string, unknown> };
      tool.inputSchema = {
        ...tool.inputSchema,
        properties: { ...(schema.properties ?? {}), [ON_BEHALF_PARAM]: { type: "string", description: `Who this write is for: your id for them; stamped by "${actsFor}:<id>"` } },
      };
    }
    const execute = tool.execute;
    tool.execute = async (params) => {
      // A batch item has no on_behalf_of of its own: the call's applies to every item. One inside an item would
      // otherwise be ignored, so it is refused.
      const inItem = Object.values(params ?? {}).some((v) => Array.isArray(v) && v.some((it) => it && typeof it === "object" && ON_BEHALF_PARAM in it));
      if (inItem) {
        throw Object.assign(new Error(`${ON_BEHALF_PARAM} goes on the call, not inside a batch item: it stamps every item. Nothing was written.`), {
          error_type: "invalid_on_behalf_of", field: ON_BEHALF_PARAM, hint: "move on_behalf_of to the top level",
        });
      }
      if (!params || !(ON_BEHALF_PARAM in params)) return execute(params);
      const { [ON_BEHALF_PARAM]: supplied, ...rest } = params;
      const r = resolveBy(supplied, actsFor, auth.actor, "mcp");
      if ("refusal" in r) throw Object.assign(new Error(r.refusal.message), { error_type: r.refusal.error_type, field: r.refusal.field, hint: r.refusal.hint });
      if (!toolStampsWriter(tool.name, rest)) {
        throw Object.assign(new Error(`${tool.name} records no writer, so ${ON_BEHALF_PARAM} would be dropped. Nothing was done. Pass it on record writes only.`), {
          error_type: "on_behalf_not_recorded", field: ON_BEHALF_PARAM, hint: "drop on_behalf_of on this call",
        });
      }
      const twin = withBy(r.by!).find((t) => t.name === tool.name);
      if (!twin) throw new Error(`${tool.name}: not available for an on-behalf-of write`);
      return twin.execute(rest);
    };
  }
}
