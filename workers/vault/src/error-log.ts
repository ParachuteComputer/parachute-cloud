/**
 * One server-side line for a crash the caller only sees as `isError` or a bare
 * 500 (T-420, audit L6-02 / L6-03). The health counters (health.ts) say how
 * often; this line says why: the error's class, a redacted message, the stack
 * frames, the worker version and the vault's opaque id.
 *
 *   event=mcp_tool_error tool=<name> class=<Class> msg="<redacted>" stack="<frames>" version=<label> vault_id=<id>
 *
 * The same shape as the self-hosted vault's line (parachute-core), so one query
 * finds both. NEVER the tool's arguments, note content, tokens, headers or the
 * vault's name: `msg` drops every quoted span (engine and JSON.parse messages
 * quote the input), and `vault_id` is the Durable Object's id, not the name.
 */

const MSG_MAX = 200;
const MAX_FRAMES = 10;

/** err.message with every quoted span ('…', "…", `…`) replaced by `…`, one line, at most 200 chars. */
export function redactMessage(message: string): string {
  return message
    .replace(/'[^']*'|"[^"]*"|`[^`]*`/g, "…")
    .replace(/["`]/g, "'") // an unbalanced quote must not end the line's own msg="…"
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MSG_MAX);
}

/** Only the `at …` frame lines of a stack (never its message line), at most 10, joined with " | ". */
export function stackFrames(stack: string | undefined): string {
  if (!stack) return "";
  return stack
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("at "))
    .slice(0, MAX_FRAMES)
    .join(" | ")
    .replace(/"/g, "'");
}

function className(err: unknown): string {
  const name = err instanceof Error ? err.constructor?.name || err.name : typeof err;
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : "unknown";
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
    `class=${className(err)}`,
    `msg="${redactMessage(message)}"`,
    `stack="${stackFrames(stack)}"`,
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
