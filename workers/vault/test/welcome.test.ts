import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { base, freshVault, op } from "./helpers.ts";
import {
  CAPTURE_ANYTHING_PATH,
  CONNECT_AI_PATH,
  GETTING_STARTED_PATH,
  NOTES_REQUIRED_TAGS,
  TAGS_GRAPH_PATH,
  WELCOME_PATH,
  YOURS_TO_KEEP_PATH,
} from "../src/welcome.ts";
import { GETTING_STARTED_PACK, welcomePack } from "@openparachute/core/src/seed-packs.js";

/**
 * Default-seed conformance: a brand-new vault materializes with the two
 * default core packs — the five-guide welcome ring + core's declared seed tags
 * (the `welcome` pack: capture/guide, asserted dynamically so this suite
 * tracks core@main) and the AI-facing Getting Started guide (the
 * `getting-started` pack) — and NOTHING else. The seed must be invisible to
 * everything that already exists: idempotent on re-entry, absent for
 * pre-existing vaults, ordinary/deletable notes, exported like any other note.
 *
 * The guides ring (vault#544): six seeded notes, all `#guide` skill files.
 * Guides are for you and your AI alike, plain markdown, so the `#guide` tag
 * carries no per-guide audience schema (written_for dropped 2026-07-06; the
 * vestigial #pinned seed dropped 2026-07-07). The `capture` tag assertion still
 * mirrors notes-ui's audit equality exactly (schema-audit.ts diffs
 * `description` + `parent_names` verbatim against NOTES_REQUIRED_SCHEMA), so
 * green there means the PWA banner clears for the right reason. The parity
 * block pins that the seeded bytes are exactly core's pack content — this repo
 * no longer carries its own copy.
 */

// The six default-seeded note paths: the five-guide welcome ring + Getting Started.
const ALL_PATHS = [
  WELCOME_PATH,
  CAPTURE_ANYTHING_PATH,
  TAGS_GRAPH_PATH,
  CONNECT_AI_PATH,
  YOURS_TO_KEEP_PATH,
  GETTING_STARTED_PATH,
];
// The five welcome guides (vs the AI-facing Getting Started); all tagged #guide.
const WELCOME_GUIDES = [WELCOME_PATH, CAPTURE_ANYTHING_PATH, TAGS_GRAPH_PATH, CONNECT_AI_PATH, YOURS_TO_KEEP_PATH];

async function listNotes(v: string): Promise<any[]> {
  const res = await op(v, "/api/notes?include_content=true");
  expect(res.status).toBe(200);
  return (await res.json()) as any[];
}

async function listTagsWithSchema(v: string): Promise<any[]> {
  const res = await op(v, "/api/tags?include_schema=true");
  expect(res.status).toBe(200);
  return (await res.json()) as any[];
}

describe("default seed — a new vault's first materialization", () => {
  it("contains exactly the 6 seeded guides and exactly core's declared seed tags", async () => {
    const v = freshVault("w");
    const notes = await listNotes(v);
    expect(notes).toHaveLength(6);
    expect(notes.map((n) => n.path).sort()).toEqual([...ALL_PATHS].sort());

    const welcome = notes.find((n) => n.path === WELCOME_PATH)!;
    expect(welcome.content).toContain("This vault is yours.");
    expect(welcome.content).toContain(`[[${CAPTURE_ANYTHING_PATH}]]`);
    const connect = notes.find((n) => n.path === CONNECT_AI_PATH)!;
    // The console origin is the deploy's ISSUER_ORIGIN (test env: TEST config).
    expect(connect.content).toContain(env.ISSUER_ORIGIN);
    // Connect-your-AI points the human at the AI-facing Getting Started guide.
    expect(connect.content).toContain(`[[${GETTING_STARTED_PATH}]]`);
    const gettingStarted = notes.find((n) => n.path === GETTING_STARTED_PATH)!;
    expect(gettingStarted.content).toContain("start-here guide");

    // The guides all carry #guide.
    for (const path of WELCOME_GUIDES) {
      const note = notes.find((n) => n.path === path)!;
      expect(note.tags, `${path} tagged #guide`).toContain("guide");
    }
    // #pinned was dropped from the seed (2026-07-07) — no seeded note is pinned.
    for (const path of WELCOME_GUIDES) {
      expect(notes.find((n) => n.path === path)!.tags).not.toContain("pinned");
    }
    expect(gettingStarted.tags).toContain("guide");

    // Exactly core's declared seed-tag set — dynamic (the welcome pack's tags:
    // capture + guide), so the assertion follows core@main rather than pinning
    // a count that a core seed-schema change would silently strand.
    const declaredTags = welcomePack({ consoleOrigin: env.ISSUER_ORIGIN as string }).tags;
    const tags = await listTagsWithSchema(v);
    expect(tags.map((t) => t.name).sort()).toEqual(declaredTags.map((d) => d.name).sort());

    // capture: notes-ui's schema-audit compares description + parent_names.
    for (const decl of NOTES_REQUIRED_TAGS) {
      const row = tags.find((t) => t.name === decl.name);
      expect(row, `tag ${decl.name} exists`).toBeTruthy();
      expect(row.description ?? "").toBe(decl.description);
      expect(row.parent_names ?? []).toEqual(decl.parent_names ?? []);
      // capture is an identity row only — no notes carry it yet.
      expect(row.count).toBe(0);
    }

    // guide is the skill-file tag — it PERSISTED through the DO store (the
    // behavioral check: the tag round-trips workerd's transactionSync seam, not
    // just the pins). written_for was dropped — no per-guide audience schema.
    const guideRow = tags.find((t) => t.name === "guide")!;
    expect(guideRow, "guide tag exists").toBeTruthy();
    expect(guideRow.fields?.written_for).toBeUndefined();
    // Six #guide notes seeded → the count reflects them (5 welcome + Getting Started).
    expect(guideRow.count).toBe(6);
    // #pinned is NOT in the seed tag set anymore (dropped 2026-07-07).
    expect(tags.find((t) => t.name === "pinned")).toBeUndefined();
  });

  it("seeded content is byte-equal to core's packs (no cloud-side fork)", async () => {
    const v = freshVault("w");
    const notes = await listNotes(v);
    const expected = [
      ...welcomePack({ consoleOrigin: env.ISSUER_ORIGIN as string }).notes,
      ...GETTING_STARTED_PACK.notes,
    ];
    expect(expected).toHaveLength(6);
    for (const { path, content } of expected) {
      const note = notes.find((n) => n.path === path);
      expect(note, `${path} seeded`).toBeTruthy();
      expect(note.content).toBe(content);
    }
  });

  it("the welcome wikilinks resolve into real link rows (the connected web)", async () => {
    const v = freshVault("w");
    const findPath = async (source: string, target: string) => {
      const res = await op(
        v,
        `/api/find-path?source=${encodeURIComponent(source)}&target=${encodeURIComponent(target)}`,
      );
      expect(res.status).toBe(200);
      return (await res.json()) as { path: string[]; relationships: string[] } | null;
    };

    // A sample of the seeded ring's direct edges: welcome → capture-anything,
    // the guides chain (capture → tags, tags → connect, connect → yours-to-keep),
    // the ring closure (yours-to-keep → welcome), and connect → getting-started.
    // Each resolves as a direct (2-node) graph path.
    for (const [source, target] of [
      [WELCOME_PATH, CAPTURE_ANYTHING_PATH],
      [CAPTURE_ANYTHING_PATH, TAGS_GRAPH_PATH],
      [TAGS_GRAPH_PATH, CONNECT_AI_PATH],
      [CONNECT_AI_PATH, YOURS_TO_KEEP_PATH],
      [YOURS_TO_KEEP_PATH, WELCOME_PATH],
      [CONNECT_AI_PATH, GETTING_STARTED_PATH],
    ] as const) {
      const found = await findPath(source, target);
      expect(found, `${source} → ${target}`).not.toBeNull();
      expect(found!.path).toHaveLength(2);
    }

    // And the hydrated-links view agrees: the welcome note carries links.
    const notes = await listNotes(v);
    const welcome = notes.find((n) => n.path === WELCOME_PATH)!;
    const point = await op(v, `/api/notes/${welcome.id}?include_links=true`);
    expect(point.status).toBe(200);
    const withLinks = (await point.json()) as any;
    expect(Array.isArray(withLinks.links)).toBe(true);
    expect(withLinks.links.length).toBeGreaterThanOrEqual(1);
  });

  it("re-running the seed does not duplicate (marker bypassed — per-item guards hold)", async () => {
    const v = freshVault("w");
    await op(v, "/api/health"); // first materialization → seeds

    const stub = env.VAULT.get(env.VAULT.idFromName(v));
    const again = await stub.seedWelcomeAgain(v);
    expect(again.seededNotes).toEqual([]);
    expect(again.skippedNotes.sort()).toEqual([...ALL_PATHS].sort());

    expect(await listNotes(v)).toHaveLength(6);
    // capture + guide — the welcome pack's full declared tag set.
    const declaredTags = welcomePack({ consoleOrigin: env.ISSUER_ORIGIN as string }).tags;
    expect(await listTagsWithSchema(v)).toHaveLength(declaredTags.length);
  });

  it("seeded notes are ordinary notes — deletable, and never re-seeded after delete", async () => {
    const v = freshVault("w");
    const notes = await listNotes(v);
    const guideNote = notes.find((n) => n.path === CAPTURE_ANYTHING_PATH)!;

    const del = await op(v, `/api/notes/${guideNote.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect((await del.json()) as any).toEqual({ deleted: true, id: guideNote.id });

    expect(await listNotes(v)).toHaveLength(5);
    // Subsequent requests don't resurrect it (the seed ran once).
    await op(v, "/api/health");
    expect(await listNotes(v)).toHaveLength(5);
  });

  it("export carries the seeded notes as ordinary portable-md entries", async () => {
    const v = freshVault("w");
    await op(v, "/api/health"); // materialize + seed
    const stub = env.VAULT.get(env.VAULT.idFromName(v));
    const entries = (await stub.exportEntries(v)) as { name: string; text: string }[];

    for (const path of ALL_PATHS) {
      const entry = entries.find((e) => e.name === `${path}.md`);
      expect(entry, `${path}.md exported`).toBeTruthy();
      expect(entry!.text.startsWith("---\n")).toBe(true); // frontmatter like any note
    }
    const welcomeEntry = entries.find((e) => e.name === `${WELCOME_PATH}.md`)!;
    expect(welcomeEntry.text).toContain("This vault is yours.");
  });

  it("a pre-existing vault (stored config, no marker) is never seeded", async () => {
    const v = freshVault("w");
    const stub = env.VAULT.get(env.VAULT.idFromName(v));
    // Simulate a vault that materialized BEFORE the welcome seed shipped: a
    // stored config, no `welcome_seeded` marker, no notes.
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("config", {
        name: v,
        description: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        audio_retention: "keep",
        auto_transcribe: { enabled: false },
      });
    });

    const res = await SELF.fetch(`${base(v)}/api/notes`, {
      headers: { Authorization: "Bearer test-operator-token" },
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as any[]).toHaveLength(0);
    const tags = await op(v, "/api/tags");
    expect((await tags.json()) as any[]).toHaveLength(0);
  });
});
