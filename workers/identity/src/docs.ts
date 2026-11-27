/**
 * The account door's refusals carry `docs` too (T-476, core docs-tool.ts): the address of the page with the fix, for
 * the version Cloud runs. The same version as the vault worker's (workers/vault/src/docs.ts); test-bun/core-version.test.ts
 * holds both equal to the pinned core's. The account door's own refusals name parachute.computer's pages (it lists no
 * docs tool; a vault's refusal through it keeps the vault's own `docs`).
 */
import type { DocsContext } from "@openparachute/core/src/docs-tool.js";

export const PARACHUTE_VERSION = "0.9.0-pre.2";

export const ACCOUNT_DOCS: DocsContext = { origin: "https://parachute.computer", version: PARACHUTE_VERSION };
