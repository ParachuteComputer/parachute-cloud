/**
 * In-process query matcher for live subscriptions — ported verbatim from
 * `parachute-vault/src/live-match.ts` (only the core import specifiers change:
 * `../core/src/*.ts` → `@openparachute/core/src/*.js`). The predicate is pure +
 * runtime-agnostic, so transcribing it keeps the DO's live matcher and bun's
 * byte-identical; `subscribe.test.ts` pins parity in the vault repo.
 *
 * The snapshot path evaluates a `QueryOpts` against the DB via the SQL engine.
 * The live path can't go back to the DB for every mutation — the changed note is
 * already in hand from the post-commit hook — so this re-implements the
 * *supported subset* of the query predicate against a single in-memory `Note`.
 * For any supported query, the set the snapshot SQL returns MUST equal the set
 * this matcher accepts. Unsupported shapes (`search`, `near`, `cursor`,
 * `has_links`, date filters) are rejected upstream with 400 and never reach here.
 */
import type { Note, QueryOpts, Store } from "@openparachute/core/src/types.js";
import { SUPPORTED_OPS } from "@openparachute/core/src/query-operators.js";

const OPS_SET: ReadonlySet<string> = new Set<string>(SUPPORTED_OPS);

/**
 * Frozen, pre-resolved form of a `QueryOpts` for fast per-note matching.
 * Tag descendant expansion (a DB read) is done once here, not per event.
 */
export interface LiveMatcher {
  readonly opts: QueryOpts;
  readonly tagSets: string[][];
  readonly tagMatch: "all" | "any";
  readonly excludeTags: string[];
  match(note: Note): boolean;
}

/**
 * Query shapes a live subscription can't evaluate against a single note.
 * The route layer rejects these with 400 before creating a subscription.
 */
export function unsupportedSubscriptionReason(opts: QueryOpts): string | null {
  // Presence, not truthiness (cloud#112, porting vault#559). `cursor: ""` is
  // the bootstrap value — still cursor INTENT, and still a query shape a live
  // subscription can't evaluate note-by-note. Truthiness let an empty-string
  // subscription through, so `?cursor=` opened a stream that silently ignored
  // the caller's pagination intent instead of rejecting it.
  if (opts.cursor !== undefined) {
    return "cursor pagination is not supported for live subscriptions";
  }
  if (opts.hasLinks !== undefined) {
    return "has_links is not supported for live subscriptions (requires the links table)";
  }
  if (opts.dateFilter || opts.dateFrom || opts.dateTo) {
    return "date filters are not supported for live subscriptions";
  }
  return null;
}

function metaValue(note: Note, key: string): unknown {
  const m = note.metadata;
  if (!m || typeof m !== "object") return undefined;
  return (m as Record<string, unknown>)[key];
}

function cmp(a: unknown, b: unknown): number | null {
  if (typeof a === "number" && typeof b === "number") return a < b ? -1 : a > b ? 1 : 0;
  const an = typeof a === "boolean" ? (a ? 1 : 0) : a;
  const bn = typeof b === "boolean" ? (b ? 1 : 0) : b;
  if (typeof an === "number" && typeof bn === "number") return an < bn ? -1 : an > bn ? 1 : 0;
  const as = String(an);
  const bs = String(bn);
  return as < bs ? -1 : as > bs ? 1 : 0;
}

function looseEq(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true;
  if (actual == null || expected == null) return actual === expected;
  if (typeof actual === "boolean" || typeof expected === "boolean") {
    return (actual ? 1 : 0) === (expected ? 1 : 0) || String(actual) === String(expected);
  }
  return String(actual) === String(expected);
}

function evalOperatorObject(actual: unknown, opObj: Record<string, unknown>): boolean {
  for (const [op, expected] of Object.entries(opObj)) {
    switch (op) {
      case "eq":
        if (expected === null) {
          if (actual !== undefined && actual !== null) return false;
        } else if (!looseEq(actual, expected)) {
          return false;
        }
        break;
      case "ne":
        if (expected === null) {
          if (actual === undefined || actual === null) return false;
        } else if (actual !== undefined && actual !== null && looseEq(actual, expected)) {
          return false;
        }
        break;
      case "gt":
      case "gte":
      case "lt":
      case "lte": {
        if (actual === undefined || actual === null) return false;
        const c = cmp(actual, expected);
        if (c === null) return false;
        if (op === "gt" && !(c > 0)) return false;
        if (op === "gte" && !(c >= 0)) return false;
        if (op === "lt" && !(c < 0)) return false;
        if (op === "lte" && !(c <= 0)) return false;
        break;
      }
      case "in": {
        if (!Array.isArray(expected)) return false;
        if (expected.length === 0) return false;
        if (actual === undefined || actual === null) return false;
        if (!expected.some((v) => looseEq(actual, v))) return false;
        break;
      }
      case "not_in": {
        if (!Array.isArray(expected)) return false;
        if (expected.length === 0) break;
        if (actual === undefined || actual === null) break;
        if (expected.some((v) => looseEq(actual, v))) return false;
        break;
      }
      case "exists": {
        const present = actual !== undefined && actual !== null;
        if (expected === true && !present) return false;
        if (expected === false && present) return false;
        break;
      }
      default:
        return false;
    }
  }
  return true;
}

function isOperatorObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value as object);
  if (keys.length === 0) return false;
  return keys.every((k) => OPS_SET.has(k));
}

/**
 * Resolve a `QueryOpts` into a frozen `LiveMatcher`, expanding tag descendants
 * once via the store (the same hierarchy the snapshot query uses).
 */
export async function buildLiveMatcher(store: Store, opts: QueryOpts): Promise<LiveMatcher> {
  const tags = opts.tags ?? [];
  const tagMatch: "all" | "any" = opts.tagMatch ?? "all";
  const tagSets: string[][] = [];
  for (const t of tags) {
    const set = await store.expandTags([t], opts.expand);
    set.add(t);
    tagSets.push(Array.from(set));
  }
  const excludeTags = opts.excludeTags ?? [];

  const matcher: LiveMatcher = {
    opts,
    tagSets,
    tagMatch,
    excludeTags,
    match(note: Note): boolean {
      return matchAgainst(note, opts, tagSets, tagMatch, excludeTags);
    },
  };
  return matcher;
}

function matchAgainst(
  note: Note,
  opts: QueryOpts,
  tagSets: string[][],
  tagMatch: "all" | "any",
  excludeTags: string[],
): boolean {
  const noteTags = note.tags ?? [];

  if (tagSets.length > 0) {
    if (tagMatch === "any") {
      const union = new Set(tagSets.flat());
      if (!noteTags.some((t) => union.has(t))) return false;
    } else {
      for (const set of tagSets) {
        if (set.length === 0) continue;
        const s = new Set(set);
        if (!noteTags.some((t) => s.has(t))) return false;
      }
    }
  }

  for (const ex of excludeTags) {
    if (noteTags.includes(ex)) return false;
  }

  if (opts.hasTags !== undefined && tagSets.length === 0) {
    const has = noteTags.length > 0;
    if (opts.hasTags !== has) return false;
  }

  if (opts.path) {
    if (!note.path || note.path.toLowerCase() !== opts.path.toLowerCase()) return false;
  }

  if (opts.pathPrefix) {
    if (!note.path || !note.path.toLowerCase().startsWith(opts.pathPrefix.toLowerCase())) return false;
  }

  if (opts.extension !== undefined) {
    const exts = Array.isArray(opts.extension) ? opts.extension : [opts.extension];
    const cleaned = exts
      .filter((e): e is string => typeof e === "string" && e.length > 0)
      .map((e) => e.toLowerCase());
    if (cleaned.length > 0) {
      const noteExt = (note.extension ?? "md").toLowerCase();
      if (!cleaned.includes(noteExt)) return false;
    }
  }

  if (opts.metadata) {
    for (const [key, value] of Object.entries(opts.metadata)) {
      const actual = metaValue(note, key);
      if (isOperatorObject(value)) {
        if (!evalOperatorObject(actual, value)) return false;
      } else {
        if (!looseEq(actual, value)) return false;
      }
    }
  }

  return true;
}
