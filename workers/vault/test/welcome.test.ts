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
  CLOUD_GUIDE_EDITS,
  withCloudGuideText,
} from "../src/welcome.ts";
import { GETTING_STARTED_PACK, welcomePack } from "@openparachute/core/src/seed-packs.js";

/**
 * Default-seed conformance: a brand-new vault materializes with the two
 * default core packs — the five-guide welcome ring + the `guide` tag (core's
 * welcome pack minus `capture`, see DEFAULT_SEED_OMITTED_TAGS) and the
 * AI-facing Getting Started guide (the `getting-started` pack) — and NOTHING else. The seed must be invisible to
 * everything that already exists: idempotent on re-entry, absent for
 * pre-existing vaults, ordinary/deletable notes, exported like any other note.
 *
 * The guides ring (vault#544): six seeded notes, all `#guide` skill files.
 * Guides are for you and your AI alike, plain markdown, so the `#guide` tag
 * carries no per-guide audience schema (written_for dropped 2026-07-06; the
 * vestigial #pinned seed dropped 2026-07-07). `capture` is NOT default-seeded
 * on cloud any more (T-318): the Notes app declares it lazily, only when the
 * owner opts in to tagging new notes as an inbox. The parity
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
  it("contains exactly the 6 seeded guides and only the guide tag (no capture)", async () => {
    const v = freshVault("w");
    const notes = await listNotes(v);
    expect(notes).toHaveLength(6);
    expect(notes.map((n) => n.path).sort()).toEqual([...ALL_PATHS].sort());

    const welcome = notes.find((n) => n.path === WELCOME_PATH)!;
    expect(welcome.content).toContain("This vault is yours.");
    expect(welcome.content).toContain(`[[${CAPTURE_ANYTHING_PATH}]]`);
    const connect = notes.find((n) => n.path === CONNECT_AI_PATH)!;
    // The note sends a person to the front door they use (my. in production),
    // CONSOLE_PUBLIC_ORIGIN, not the OAuth issuer host (T-318 night audit:
    // newcomers were sent to cloud.parachute.computer).
    expect(connect.content).toContain(env.CONSOLE_PUBLIC_ORIGIN);
    expect(connect.content).not.toContain(env.ISSUER_ORIGIN);
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

    // Exactly ONE seeded tag: `guide`. Core's welcome pack also declares
    // `capture` (NOTES_REQUIRED_TAGS); the cloud default seed drops it
    // (T-318 / DESIGN-0.9 §8b: `#capture` is opt-in in the Notes app, which
    // declares it lazily on first use). Assert the core side still declares
    // it, so this test notices if core changes underneath the filter.
    const declaredTags = welcomePack({ consoleOrigin: env.CONSOLE_PUBLIC_ORIGIN as string }).tags;
    expect(declaredTags.map((d) => d.name)).toEqual(
      expect.arrayContaining(NOTES_REQUIRED_TAGS.map((d) => d.name)),
    );
    const tags = await listTagsWithSchema(v);
    expect(tags.map((t) => t.name).sort()).toEqual(["guide"]);
    expect(tags.find((t) => t.name === "capture"), "no capture tag on a fresh vault").toBeUndefined();
    // And no seeded note carries it either.
    for (const note of notes) {
      expect(note.tags, `${note.path} not tagged #capture`).not.toContain("capture");
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

  it("seeded content is byte-equal to core's packs plus the listed cloud corrections", async () => {
    const v = freshVault("w");
    const notes = await listNotes(v);
    const expected = [
      ...withCloudGuideText(welcomePack({ consoleOrigin: env.CONSOLE_PUBLIC_ORIGIN as string })).notes,
      ...withCloudGuideText(GETTING_STARTED_PACK).notes,
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
    // The re-run converges on the same filtered set: guide only, no capture.
    expect(again.tags).not.toContain("capture");
    expect((await listTagsWithSchema(v)).map((t) => t.name)).toEqual(["guide"]);
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

/**
 * T-318: the Notes app no longer tags what you write `#capture` unless you turn
 * on "Tag new notes as an inbox" (Settings → Tag roles). Core's guide text at
 * the pinned commit still says it does ("Tags and the graph", "Getting
 * Started"), so the cloud seed corrects those sentences. A fresh vault's guides
 * must make no claim that notes are auto-tagged, and must still teach how to
 * opt in.
 */
describe("the seeded guides tell the truth about #capture", () => {
  // Phrases that claim the app tags everything (core's pinned wording).
  const AUTO_TAG_CLAIMS = [
    /puts it on whatever you write/i,
    /`capture` tag the Notes surface uses/i,
    /starts with just two/i,
  ];

  function expectNoAutoTagClaim(notes: Array<{ path: string; content: string }>) {
    for (const note of notes) {
      for (const claim of AUTO_TAG_CLAIMS) {
        expect(note.content, `${note.path} must not claim ${claim}`).not.toMatch(claim);
      }
    }
  }

  it("a fresh vault's guides never say notes are auto-tagged, and teach the opt-in", async () => {
    const v = freshVault("w");
    const notes = await listNotes(v);
    expect(notes).toHaveLength(6);
    expectNoAutoTagClaim(notes);

    const tagsNote = notes.find((n) => n.path === TAGS_GRAPH_PATH)!;
    expect(tagsNote.content).toContain('"Tag new notes as an inbox"');
    expect(tagsNote.content).toContain("It's off unless you turn it on.");
    // The tag the guides do carry is still named.
    expect(tagsNote.content).toContain("#guide");

    const gs = notes.find((n) => n.path === GETTING_STARTED_PATH)!;
    expect(gs.content).toContain("only if the person turns on its inbox option");
  });

  it("an explicit POST /api/packs/welcome re-seeds the corrected text too", async () => {
    const v = freshVault("w");
    const before = (await listNotes(v)).find((n) => n.path === TAGS_GRAPH_PATH)!;
    expect((await op(v, `/api/notes/${before.id}`, { method: "DELETE" })).status).toBe(200);
    const gs = (await listNotes(v)).find((n) => n.path === GETTING_STARTED_PATH)!;
    expect((await op(v, `/api/notes/${gs.id}`, { method: "DELETE" })).status).toBe(200);

    for (const pack of ["welcome", "getting-started"]) {
      const res = await op(v, `/api/packs/${pack}`, { method: "POST" });
      expect(res.status, pack).toBe(200);
    }
    const notes = await listNotes(v);
    expect(notes.map((n) => n.path)).toEqual(expect.arrayContaining([TAGS_GRAPH_PATH, GETTING_STARTED_PATH]));
    expectNoAutoTagClaim(notes);
    expect(notes.find((n) => n.path === TAGS_GRAPH_PATH)!.content).toContain('"Tag new notes as an inbox"');
  });

  it("every cloud correction still matches core's text (a core bump that fixes it upstream trips this)", () => {
    const core = [...welcomePack({ consoleOrigin: env.CONSOLE_PUBLIC_ORIGIN as string }).notes, ...GETTING_STARTED_PACK.notes];
    expect(CLOUD_GUIDE_EDITS.length).toBeGreaterThan(0);
    for (const edit of CLOUD_GUIDE_EDITS) {
      const note = core.find((n) => n.path === edit.path);
      expect(note, edit.path).toBeTruthy();
      // If this fails after a vault-source.env bump, core changed the sentence:
      // check its new wording and drop or update this edit.
      expect(note!.content, `${edit.path}: core text the edit replaces`).toContain(edit.from);
    }
  });
});
