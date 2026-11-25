/**
 * Where this door's docs are, and which version they're for (T-476, core docs-tool.ts): the engine's `docs` tool, the
 * brief's Docs line and every refusal's `docs` address read it. The origin is parachute.computer unless the worker's
 * `PARACHUTE_DOCS_URL` says otherwise (a personal door's own copy of the site, a test's closed port; `off` for none).
 */
import { docsOrigin, type DocsContext } from "@openparachute/core/src/docs-tool.js";

/**
 * The Parachute version this door runs: the pinned parachute-core's (`PARACHUTE_CORE_VERSION` in
 * scripts/core-source.env; test-bun/core-version.test.ts holds the two equal, so a pin move that changes the version
 * changes this too). The engine package itself is 0.1.0 and never moves, so it can't say.
 */
export const PARACHUTE_VERSION = "0.9.0-pre.2";

/** This door's docs, from the worker's env (empty: parachute.computer). */
export function cloudDocs(env: { PARACHUTE_DOCS_URL?: string } | undefined): DocsContext {
  return { origin: docsOrigin(env?.PARACHUTE_DOCS_URL ?? "", null), version: PARACHUTE_VERSION };
}
