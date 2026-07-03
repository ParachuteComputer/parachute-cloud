/**
 * Welcome seed — the content a brand-new cloud vault materializes with, so the
 * first thing an everyday user sees in the Notes PWA is a small living graph
 * instead of an empty list + a schema warning banner.
 *
 * Two halves:
 *
 *  1. The three `capture` tags Notes declares as its required schema. The
 *     shape is copied EXACTLY from notes-ui's `NOTES_REQUIRED_SCHEMA`
 *     (parachute-surface/packages/notes-ui/src/lib/vault/schema.ts): the PWA's
 *     connect-time audit (schema-audit.ts) compares `description` and
 *     `parent_names` verbatim, so the banner clears because the tags genuinely
 *     exist with the semantics Notes declares — not because we gamed the check.
 *     (Self-hosted, notes-ui writes these itself on the first capture via
 *     `ensureNotesSchema`; seeding them at creation means the FIRST connect is
 *     already clean.)
 *
 *  2. A three-note welcome web (welcome → try-linking → back, connect-AI →
 *     welcome) so the graph view shows a connected structure from minute one.
 *     They are ordinary notes — no special flags, deletable like anything else.
 *
 * Mirrors the bun vault's own create-time pattern (parachute-vault
 * src/onboarding-seed.ts): runs at vault creation, idempotent per item (a note
 * is written only when no note exists at its path; tag upserts are idempotent
 * by nature), best-effort at the call site (a seed failure must never fail the
 * vault). Content intentionally lives HERE, not in @openparachute/core — the
 * bun vault's seeded notes (Getting Started / Surface Starter) address a
 * connected AI; the cloud's welcome addresses the everyday console user.
 */
import type { Store } from "@openparachute/core/src/types.js";

/** Storage key for the per-DO "welcome seed already ran" marker. */
export const WELCOME_SEEDED_KEY = "welcome_seeded";

/**
 * The tags Notes requires — name/description/parent_names must stay byte-equal
 * to notes-ui's NOTES_REQUIRED_SCHEMA or the PWA's audit flags them misaligned.
 */
export const NOTES_REQUIRED_TAGS: ReadonlyArray<{
  name: string;
  description: string;
  parent_names?: string[];
}> = [
  {
    name: "capture",
    description: "Notes captured directly by the user (text or voice).",
  },
  {
    name: "capture/text",
    parent_names: ["capture"],
    description: "Text capture.",
  },
  {
    name: "capture/voice",
    parent_names: ["capture"],
    description: "Voice capture.",
  },
];

export const WELCOME_PATH = "Welcome to your vault 🪂";
export const TRY_LINKING_PATH = "Try linking notes";
export const CONNECT_AI_PATH = "Connect your AI";

/** The three welcome notes, in creation order. `[[wikilinks]]` resolve by note
 *  path — pending links auto-resolve when the target is created, so order only
 *  affects how briefly a link sits unresolved during the seed. */
export function welcomeNotes(consoleOrigin: string): ReadonlyArray<{ path: string; content: string }> {
  return [
    {
      path: WELCOME_PATH,
      content: `# ${WELCOME_PATH}

This vault is yours.
Write anything.
Notes can link to each other, like this: [[${TRY_LINKING_PATH}]].
`,
    },
    {
      path: TRY_LINKING_PATH,
      content: `# ${TRY_LINKING_PATH}

Wrap a note's name in double square brackets to make a wikilink, like this one back to [[${WELCOME_PATH}]].
`,
    },
    {
      path: CONNECT_AI_PATH,
      content: `# ${CONNECT_AI_PATH}

Your vault speaks MCP. Grab the connection URL from your console at ${consoleOrigin}.
Start from [[${WELCOME_PATH}]].
`,
    },
  ];
}

export interface WelcomeSeedResult {
  /** Note paths written this run. */
  seededNotes: string[];
  /** Note paths skipped because a note already lives there (idempotency). */
  skippedNotes: string[];
  /** Tag names upserted (upserts are idempotent; always all three). */
  tags: string[];
}

/**
 * Seed the welcome content into `store`. Idempotent per item: each note is
 * created only when no note exists at its path, and the tag upserts converge
 * on the same rows — so a re-run (marker lost, double cold-start) can never
 * duplicate, and never clobbers a note the user has since edited or recreated.
 *
 * Uses only single-item Store calls — they route through the DO's real
 * `transactionSync` seam, keeping the conformance suite's zero-raw-BEGIN
 * tripwire honest.
 */
export async function seedWelcome(store: Store, opts: { consoleOrigin: string }): Promise<WelcomeSeedResult> {
  const result: WelcomeSeedResult = { seededNotes: [], skippedNotes: [], tags: [] };

  // Parent first so `parent_names` reads naturally in logs (the store accepts
  // forward references, but the order matches the conceptual model).
  for (const decl of NOTES_REQUIRED_TAGS) {
    await store.upsertTagRecord(decl.name, {
      description: decl.description,
      ...(decl.parent_names ? { parent_names: decl.parent_names } : {}),
    });
    result.tags.push(decl.name);
  }

  for (const { path, content } of welcomeNotes(opts.consoleOrigin)) {
    const existing = await store.getNoteByPath(path);
    if (existing) {
      result.skippedNotes.push(path);
      continue;
    }
    await store.createNote(content, { path });
    result.seededNotes.push(path);
  }

  return result;
}
