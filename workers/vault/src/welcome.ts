/**
 * First-materialization seed — the DO-side wrapper around @openparachute/core's
 * seed packs (core/src/seed-packs.ts, the single source of truth for pack
 * content across BOTH runtimes since vault#526). A brand-new cloud vault seeds:
 *
 *  1. The `welcome` pack — the `capture` tag Notes' schema audit requires
 *     (ONE tag since vault#528; entry method lives in note metadata.source)
 *     + the three-note welcome web (welcome → try-linking → back,
 *     connect-AI → welcome), person-voiced, with the console origin
 *     (ISSUER_ORIGIN) named in the Connect-your-AI note. This content used to
 *     live verbatim in this file; it was ported INTO core (test-pinned
 *     byte-equal there) and is now imported back.
 *
 *  2. The `getting-started` pack — the AI-facing start-here guide. Seeding it
 *     makes core's vault-projection emit its `getting_started` pointer, so an
 *     MCP client connecting to a cloud vault gets the same "Start here"
 *     orientation a self-hosted bun vault gets.
 *
 * (`surface-starter` is deliberately NOT default-seeded — ratified 2026-07-02.
 * It's applied on demand via POST /api/packs/surface-starter, which the
 * console's "Add the Surface Starter guide" button drives.)
 *
 * What stays HERE is the DO-side policy, not the content: the
 * `welcome_seeded` marker key, the seed-both-packs orchestration, and the
 * result shape the seed RPC/tests consume. The caller (vault-do.ts
 * maybeSeedWelcome) keeps the zero-notes guard + best-effort semantics —
 * core's `applySeedPack` propagates errors by design and is idempotent per
 * item (notes created only when absent; tag upserts converge), so a
 * marker-loss re-run can never duplicate or clobber user edits.
 */
import type { Store } from "@openparachute/core/src/types.js";
import {
  GETTING_STARTED_PACK,
  applySeedPack,
  welcomePack,
} from "@openparachute/core/src/seed-packs.js";

// Re-exported so the conformance tests assert against the SAME constants the
// seed writes (single import site; content lives in core).
export {
  CONNECT_AI_PATH,
  GETTING_STARTED_PATH,
  NOTES_REQUIRED_TAGS,
  TRY_LINKING_PATH,
  WELCOME_PATH,
} from "@openparachute/core/src/seed-packs.js";

/** Storage key for the per-DO "welcome seed already ran" marker. */
export const WELCOME_SEEDED_KEY = "welcome_seeded";

export interface WelcomeSeedResult {
  /** Note paths written this run (across both default packs). */
  seededNotes: string[];
  /** Note paths skipped because a note already lives there (idempotency). */
  skippedNotes: string[];
  /** Tag names upserted (upserts are idempotent; always core's full declared set). */
  tags: string[];
}

/**
 * Apply the default seed packs (`welcome` + `getting-started`) to `store`.
 * Idempotent per item via core's `applySeedPack` — a re-run (marker lost,
 * double cold-start) converges instead of duplicating, and never clobbers a
 * note the user has since edited or recreated.
 *
 * Core's applier uses only single-item Store calls — they route through the
 * DO's real `transactionSync` seam, keeping the conformance suite's
 * zero-raw-BEGIN tripwire honest.
 */
export async function seedWelcome(store: Store, opts: { consoleOrigin: string }): Promise<WelcomeSeedResult> {
  const result: WelcomeSeedResult = { seededNotes: [], skippedNotes: [], tags: [] };
  for (const pack of [welcomePack({ consoleOrigin: opts.consoleOrigin }), GETTING_STARTED_PACK]) {
    const applied = await applySeedPack(store, pack);
    result.seededNotes.push(...applied.seededNotes);
    result.skippedNotes.push(...applied.skippedNotes);
    result.tags.push(...applied.tags);
  }
  return result;
}
