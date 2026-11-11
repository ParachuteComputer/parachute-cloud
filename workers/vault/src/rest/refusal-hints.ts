/**
 * What a refusal tells the caller to do next. The box (parachute-core `packages/vault/src/routes.ts`,
 * `conflictResponse` and the PATCH precondition) sends a `hint` with each of these; this door's REST fork had
 * dropped them, so an agent that got a 409 here was told less than the same agent on a box.
 *
 * The words are the box's, kept exact: the door contracts (parachute-core `contracts/suites/door`) compare a hash
 * of each hint across doors, so a change on one side fails there until the other follows.
 */
export const HINT_CONFLICT =
  "re-read the note (GET) and re-apply your change against its current `updated_at`, or pass `force: true` to overwrite";
export const HINT_TRANSITION_CONFLICT =
  "re-read the note's current value for this field and retry the transition from its actual current state";
export const HINT_SCHEMA_VALIDATION = "fix every field listed in `violations` and retry — none of this write was applied";
/** On an update: the note keeps its path if none is given. */
export const HINT_PATH_CONFLICT = "pass a different `path`, or omit it to leave the existing path unchanged";
/** On a create (single or batch): with no path the vault assigns one. */
export const HINT_PATH_CONFLICT_ON_CREATE = "pass a different `path`, or omit it to let the vault assign one";
export const HINT_PRECONDITION =
  "re-read the note, pass its `updated_at` as `if_updated_at`, or pass `force: true` to skip the check";
export const HINT_HISTORY_OVERFLOW =
  "this note exceeds the 2 MB version-history ceiling, so it cannot be updated while history is enabled; delete it, or shrink it out-of-band, or disable history for this vault";
export const hintHistoryUnrecoverable = (reason: unknown): string =>
  reason === "delta_orphan"
    ? "this version's stored delta cannot be rebuilt — its base blob is missing or corrupt; run GET /api/doctor for the `history_delta_orphan` finding"
    : "this version is an overflow tombstone — the note's size and deletion were recorded but its content never was";
