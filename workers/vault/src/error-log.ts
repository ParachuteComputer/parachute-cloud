/**
 * One server-side line for a crash the caller only sees as `isError` or a bare
 * 500 (T-420, audit L6-02 / L6-03). The health counters (health.ts) say how
 * often; this line says why: the error's class, a redacted message, the stack
 * frames, the worker version and the vault's opaque id.
 *
 *   event=mcp_tool_error tool=<name> class=<Class> msg="<redacted>" stack="<frames>" version=<label> vault_id=<id>
 *
 * The same shape as the self-hosted vault's line (parachute-core), so one query
 * finds both. The arguments, headers, tokens and the vault's name are never
 * passed in; `vault_id` is the Durable Object's id. The message is the one
 * place input could ride along, so `msg` drops everything from its first quote
 * to its last (engine and JSON.parse messages quote the input, and quoted JSON
 * has quotes inside) and `stack` keeps only real frame lines. Input a message carries WITHOUT quotes would still show; the lines are
 * written only for runtime faults (TypeError and kin, health.ts
 * toolErrorOutcome), whose messages the runtime words.
 */

import { errorClassName } from "./health.js";

const MSG_MAX = 200;
const MAX_FRAMES = 10;

/**
 * err.message with every quoted span ('…', "…", `…`) replaced by `…`, one line,
 * at most 200 chars. Quotes are not paired: everything from the first quote
 * character to the last goes (a lone one takes the rest), so a span with the
 * same quote inside it (`"{"key": 1}"`) or an apostrophe cannot let input
 * through. Over-redacting ("Can't …" → "Can…") is the safe side.
 */
export function redactMessage(message: string): string {
  const first = message.search(/['"`]/);
  let out = message;
  if (first >= 0) {
    const last = Math.max(message.lastIndexOf("'"), message.lastIndexOf('"'), message.lastIndexOf("`"));
    out = message.slice(0, first) + "…" + (last > first ? message.slice(last + 1) : "");
  }
  return out.replace(/\s+/g, " ").trim().slice(0, MSG_MAX);
}

/**
 * Only the `at …` frame lines of a stack, at most 10, joined with " | ". The
 * stack opens with the message, which may span lines (one could even start
 * with "at "), so everything up to the end of `message` is skipped first, and
 * a line counts only in a V8 frame's shape: ending in `:line:col`, `<anonymous>`
 * or `native` (in parentheses or not) — in case the message changed after the
 * stack was taken.
 */
const FRAME = /^at .*(?::\d+:\d+|<anonymous>|native)\)?$/;
export function stackFrames(stack: string | undefined, message?: string): string {
  if (!stack) return "";
  const at = message ? stack.indexOf(message) : -1;
  const frames = at >= 0 ? stack.slice(at + message!.length) : stack;
  return frames
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => FRAME.test(l))
    .slice(0, MAX_FRAMES)
    .join(" | ")
    .replace(/"/g, "'");
}

/** A server-defined token (tool name, version label, DO id): anything outside a small alphabet becomes `_`. */
function token(s: string): string {
  return s.replace(/[^A-Za-z0-9:/_.~-]/g, "_").slice(0, 80) || "_";
}

export interface ErrorLogFields {
  /** The MCP tool's own name (one of this vault's visible tools). */
  tool?: string;
  /** The deployed worker version label (health.ts versionLabel). */
  version: string;
  /** The vault Durable Object's id (`ctx.id.toString()`), never the vault's name. */
  vaultId: string;
}

/** The line itself (exported for tests); {@link logServerError} writes it. */
export function serverErrorLine(event: string, err: unknown, f: ErrorLogFields): string {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  return [
    `event=${token(event)}`,
    ...(f.tool !== undefined ? [`tool=${token(f.tool)}`] : []),
    `class=${errorClassName(err)}`,
    `msg="${redactMessage(message)}"`,
    `stack="${stackFrames(stack, message)}"`,
    `version=${token(f.version)}`,
    `vault_id=${token(f.vaultId)}`,
  ].join(" ");
}

/** Write one {@link serverErrorLine} with console.error. Never throws. */
export function logServerError(event: string, err: unknown, f: ErrorLogFields): void {
  try {
    console.error(serverErrorLine(event, err, f));
  } catch {
    /* a log line must never break the request it describes */
  }
}
