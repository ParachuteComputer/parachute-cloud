/**
 * First-materialization seed — the DO-side wrapper around @openparachute/core's
 * seed packs (core/src/seed-packs.ts, the single source of truth for pack
 * content across BOTH runtimes since vault#526). A brand-new cloud vault seeds:
 *
 *  1. The `welcome` pack — the five-guide welcome ring (Welcome to your vault,
 *     Capture anything, Tags and the graph, Connect your AI, Yours to keep;
 *     the guides-ring rewrite, vault#544) + the `guide` tag (the skill-file
 *     tag; no schema — guides are for you and your AI alike, plain markdown).
 *     Core's pack also declares `capture`; the cloud default seed drops it
 *     (T-318, DESIGN-0.9 §8b/§8c): `#capture` is opt-in in the Notes app now,
 *     and the app declares the tag lazily the first time it actually adds it.
 *     See DEFAULT_SEED_OMITTED_TAGS below. Core's guide text still says the
 *     app tags everything #capture; CLOUD_GUIDE_EDITS below corrects those
 *     passages (default seed AND explicit pack apply). The five guides are ordinary notes tagged `#guide`,
 *     forming a small linked web (Welcome → all four; the rest chain,
 *     Connect-your-AI also links [[Getting Started]]).
 *     The Connect-your-AI note names the console origin (ISSUER_ORIGIN). This
 *     content used to live verbatim in this file; it was ported INTO core
 *     (test-pinned byte-equal there) and is now imported back.
 *
 *  2. The `getting-started` pack — the AI-facing start-here guide, itself a
 *     `#guide` note. Seeding it makes core's
 *     vault-projection emit its `getting_started` pointer, so an MCP client
 *     connecting to a cloud vault gets the same "Start here" orientation a
 *     self-hosted bun vault gets.
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
  GETTING_STARTED_PATH,
  TAGS_GRAPH_PATH,
  type SeedPack,
  applySeedPack,
  welcomePack,
} from "@openparachute/core/src/seed-packs.js";

// Re-exported so the conformance tests assert against the SAME constants the
// seed writes (single import site; content lives in core). The guides-ring set
// (vault#544): the five welcome paths + Getting Started, plus core's tag
// declarations (NOTES_REQUIRED_TAGS = capture, NOT default-seeded on cloud;
// GUIDE_TAG, seeded).
export {
  CAPTURE_ANYTHING_PATH,
  CONNECT_AI_PATH,
  GETTING_STARTED_PATH,
  GUIDE_TAG,
  NOTES_REQUIRED_TAGS,
  TAGS_GRAPH_PATH,
  WELCOME_PATH,
  YOURS_TO_KEEP_PATH,
} from "@openparachute/core/src/seed-packs.js";

/** Storage key for the per-DO "welcome seed already ran" marker. */
export const WELCOME_SEEDED_KEY = "welcome_seeded";

/**
 * Tags core's default packs declare that a fresh CLOUD vault does not get.
 * `capture` used to be declared because the Notes app required it; the app no
 * longer tags new notes `#capture` unless the owner opts in, and declares the
 * tag itself on first use. Only the create-time default seed is filtered — an
 * explicit `POST /api/packs/welcome` still applies core's full pack (the
 * caller asked for exactly that pack). Existing vaults are never re-seeded
 * (the `welcome_seeded` marker + stored-config guard in vault-do.ts), so
 * their `capture` tag and notes are untouched.
 */
export const DEFAULT_SEED_OMITTED_TAGS: ReadonlySet<string> = new Set(["capture"]);

/** The default pack minus the tags a fresh cloud vault should not carry. */
function forDefaultSeed(pack: SeedPack): SeedPack {
  return { ...pack, tags: pack.tags.filter((t) => !DEFAULT_SEED_OMITTED_TAGS.has(t.name)) };
}

export interface WelcomeSeedResult {
  /** Note paths written this run (across both default packs). */
  seededNotes: string[];
  /** Note paths skipped because a note already lives there (idempotency). */
  skippedNotes: string[];
  /** Tag names upserted (idempotent; core's declared set minus DEFAULT_SEED_OMITTED_TAGS). */
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
  // Seed order is what a newcomer sees first. Time doesn't move inside the DO
  // seed, so all six guides share one timestamp and newest-first lists fall
  // back to id order. Core's note ids are monotonic ULIDs (core src/ulid.ts:
  // within one millisecond the next id increments the last), so id order IS
  // seed order: seed the AI-facing Getting Started first and the welcome ring
  // backwards, so a Recent list opens on "Welcome to your vault".
  for (const pack of [GETTING_STARTED_PACK, newestFirst(welcomePack({ consoleOrigin: opts.consoleOrigin }))]) {
    const applied = await applySeedPack(store, withCloudGuideText(forDefaultSeed(pack)));
    result.seededNotes.push(...applied.seededNotes);
    result.skippedNotes.push(...applied.skippedNotes);
    result.tags.push(...applied.tags);
  }
  return result;
}

/** `pack` with its notes in reverse, so the first note reads first in a newest-first list. */
function newestFirst(pack: SeedPack): SeedPack {
  return { ...pack, notes: [...pack.notes].reverse() };
}

/**
 * Cloud corrections to core's guide text (T-318). Core's guides, at the pinned
 * commit, say the Notes app puts `#capture` on whatever you write; it no longer
 * does unless the owner turns on "Tag new notes as an inbox" (Settings → Tag
 * roles). Each edit swaps one exact passage of core's text for the true one
 * and leaves the rest of the note byte-equal to core. welcome.test.ts checks
 * every `from` still appears in core, so a core-source.env bump that fixes the
 * text upstream fails loudly here instead of silently keeping a stale edit.
 * The new wording holds whether or not the vault declares `capture` (the
 * default seed omits it; an explicit welcome-pack apply declares it).
 */
export const CLOUD_GUIDE_EDITS: ReadonlyArray<{ path: string; from: string; to: string }> = [
  {
    path: TAGS_GRAPH_PATH,
    from: `everything half-finished. Your vault starts with just two:

- #capture — the Notes app puts it on whatever you write or speak in directly,
  marking your own raw words.
- #guide — these notes.
`,
    to: `everything half-finished. Your vault starts with #guide, on these notes.

Want an inbox? In the Notes app, open Settings → Tag roles and turn on
"Tag new notes as an inbox". Then a new note you write or speak in without a
tag gets an inbox tag (#capture unless you change it), so you can sort it
later. It's off unless you turn it on.
`,
  },
  {
    path: GETTING_STARTED_PATH,
    from: `small welcome web and the \`capture\` tag the Notes surface uses; no other
predefined tags or schema.`,
    to: `small welcome web tagged \`guide\`; no other predefined tags or schema. (The
Notes app tags new notes \`capture\` only if the person turns on its inbox option,
"Tag new notes as an inbox".)`,
  },
];

/** `pack` with {@link CLOUD_GUIDE_EDITS} applied to its notes (others untouched). */
export function withCloudGuideText(pack: SeedPack): SeedPack {
  return {
    ...pack,
    notes: pack.notes.map((note) => {
      let content = note.content;
      for (const edit of CLOUD_GUIDE_EDITS) {
        if (edit.path === note.path) content = content.replace(edit.from, () => edit.to);
      }
      return content === note.content ? note : { ...note, content };
    }),
  };
}
