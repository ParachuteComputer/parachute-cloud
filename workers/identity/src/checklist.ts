/**
 * Getting-started checklist state + the first-run research answer (guided
 * arrival, cloud#52-adjacent). Storage seam over migration 0007.
 *
 * The checklist is per-user rows in `user_checklist` — see the migration's
 * rationale for table-over-JSON (idempotent concurrent-safe INSERT OR IGNORE,
 * per-item `done_at` for research, item set extensible without schema churn).
 * Dismissing the whole card is the same mechanism: a reserved `hidden` item.
 *
 * Design principles (ratified): every item is a DOOR (it takes you to the next
 * step, never just describes it); guidance is dismissible, never a modal wall.
 */

/** The five checklist items, in render order. Keys are stable API surface. */
export const CHECKLIST_ITEMS = [
  "open-notes",
  "write-note",
  "connect-ai",
  "add-phone",
  "import-notes",
] as const;
export type ChecklistItem = (typeof CHECKLIST_ITEMS)[number];

/** Reserved item key: the user dismissed the whole checklist card. */
export const CHECKLIST_HIDDEN = "hidden";

const VALID_ITEMS: ReadonlySet<string> = new Set([...CHECKLIST_ITEMS, CHECKLIST_HIDDEN]);

export function isChecklistItem(raw: string): boolean {
  return VALID_ITEMS.has(raw);
}

export interface ChecklistState {
  /** Item keys marked done (never includes `hidden`). */
  done: ReadonlySet<string>;
  /** True when the user dismissed the card ("hide this"). */
  hidden: boolean;
}

export async function getChecklistState(db: D1Database, userId: string): Promise<ChecklistState> {
  const res = await db
    .prepare("SELECT item FROM user_checklist WHERE user_id = ?")
    .bind(userId)
    .all<{ item: string }>();
  const done = new Set<string>();
  let hidden = false;
  for (const row of res.results ?? []) {
    if (row.item === CHECKLIST_HIDDEN) hidden = true;
    else done.add(row.item);
  }
  return { done, hidden };
}

/**
 * Bring a dismissed checklist card back (the console's "Show setup guide"
 * footer link): delete the reserved `hidden` row. Done rows are untouched —
 * restored progress renders exactly where the user left it. Idempotent.
 */
export async function unhideChecklist(db: D1Database, userId: string): Promise<void> {
  await db
    .prepare("DELETE FROM user_checklist WHERE user_id = ? AND item = ?")
    .bind(userId, CHECKLIST_HIDDEN)
    .run();
}

/**
 * Mark an item done (or `hidden`). Idempotent — re-clicking a door keeps the
 * original `done_at`. Unknown items are the caller's job to refuse first.
 */
export async function markChecklistItem(
  db: D1Database,
  userId: string,
  item: string,
  now: Date = new Date(),
): Promise<void> {
  await db
    .prepare("INSERT OR IGNORE INTO user_checklist (user_id, item, done_at) VALUES (?, ?, ?)")
    .bind(userId, item, now.toISOString())
    .run();
}

// --- first-run research answer ----------------------------------------------

/**
 * The "What do you take notes in today?" chip values — MIRRORS the landing
 * page's set (landing-preview.html radiogroup `notes_app`), so the research
 * data joins across both funnels.
 */
export const NOTES_APP_OPTIONS = [
  { value: "apple-notes", label: "Apple Notes" },
  { value: "notion", label: "Notion" },
  { value: "obsidian", label: "Obsidian" },
  { value: "paper", label: "Paper" },
  { value: "nothing", label: "Nothing yet" },
] as const;

const NOTES_APP_VALUES: ReadonlySet<string> = new Set(NOTES_APP_OPTIONS.map((o) => o.value));

/**
 * Persist the research answer on the user row. Only allowlisted values are
 * written (the field is user-editable form data); anything else is a no-op.
 */
export async function setNotesApp(db: D1Database, userId: string, raw: string): Promise<void> {
  if (!NOTES_APP_VALUES.has(raw)) return;
  await db.prepare("UPDATE users SET notes_app = ? WHERE id = ?").bind(raw, userId).run();
}
