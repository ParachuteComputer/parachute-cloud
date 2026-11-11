# Hosted note history

Hosted vaults use the shared Vault history engine and SQLite migrations. Existing
notes remain current; upgrading does not invent versions for earlier edits.
Subsequent supported edits and deletions capture prior note states.

## Read and restore

- `GET /api/notes/:id/versions?limit=50&offset=0`: list retained versions.
- `GET /api/notes/:id/versions/:version_ix`: read a native version.
- `GET /api/notes/:id/imports/:import_ix`: read an imported snapshot, if present.
- `POST /api/notes/:id/restore`: select `{version_ix}` or
  `{origin:"git-import",import_ix}`. An existing note requires its observed
  `if_updated_at`. A stale value returns 409; a missing precondition returns 428.

Restore is a new recoverable edit. It restores content, metadata and extension,
not an old path or tag assignment. Deleted-note recovery uses the ID and the
deletion-time path. Corrupt or unrecorded content cannot be restored. Versions
may have been pruned under retention policy; an empty list is not evidence that
the note was never edited.

MCP `query-notes` supports the shared `versions` selector. Restore remains
REST-only, as on self-hosted Vault; no new MCP restore tool is advertised.

## Read-only content audit

`GET /api/doctor?deep=true` and MCP `doctor` with `deep: true` opt into
materializing retained history blobs and verifying their content hashes. The
default doctor scan remains unchanged. Both doors accept `history_after` (a
64-character lowercase hash cursor), `history_max_blobs` (1–500, default 100),
and `history_budget_ms` (1–1000, default 250).

The `history_audit` result reports `checked`, `corrupt`, up to five example
hashes, `complete`, and `next_after`. Continue with `next_after` until complete;
an incomplete page is not a clean bill of health. Budgets are checked between
blobs, not inside a materialization, and do not bound the ordinary structural
doctor scan. Pages over a live vault are not a snapshot. Use a stable copied
database for an exhaustive audit. Scans never repair or rewrite data, and
operational failures are not relabeled as corruption. Deep scans require an
unrestricted session; Cloud's existing rejection of scoped tokens is unchanged.

## Permissions and storage

Reads require vault read access; restore requires write access and obeys existing
frozen-account and storage-cap checks. Historical editor provenance is retained
for unrestricted readers. Cloud still rejects tag-scoped credentials entirely;
this change does not enable partial tag-scope support. The REST projection uses
the shared restricted-reader helper for future fully supported scoped access.

`DELETE /api/notes/:id/versions` permanently erases history and requires admin.
It is deliberately separate from ordinary restore. `POST /api/history/compact`
also requires admin; it accepts `note_id`, `budget_ms` and `max_notes` as on Vault.
Hosted requests default to, and clamp at, 250ms / 50 notes per pass; unlike the
self-hosted operator batch endpoint they cannot request an unbounded pass.
The budget is checked between notes, not a hard deadline inside one note or the
candidate scan. Inspect the returned summary and repeat if needed.
Schema 32 backfills per-note scheduling hints once. Subsequent candidate selection
uses the indexed hints, ordered by stored bytes, with a window four times the note
limit. `remaining_candidates` is the total eligible count at selection time minus
attempted notes, not the window size. No-op compactions are refused until another
history write re-arms them; zero-live-byte notes are excluded from ratio-based
selection, but remain eligible when over the byte ceiling. Retained deleted-note
history still compacts. Shared-blob rewrites update all affected hints without
re-arming unrelated notes. Doctor samples up to 200 largest hints and emits a
read-only `history_compact_state_drift` warning on counter disagreement; this is not
a full audit or repair. Compaction still reads authoritative history in its transaction.
Reopening after an older schema writer automatically rebuilds hints from retained
history, including when version-ledger timestamps tie (the lower version wins).
A normal v32 reopen preserves refusal flags. If drift has another cause, report
the missed-refresh bug: hosted repair arrives through a numbered core migration
and pin update, not an operator REST call. Doctor remains read-only. The manual
`history rebuild-state` CLI escape hatch is self-hosted only.
This POST retains the hosted frozen/cap write gate; history erasure remains
available when capped, but manual compaction is not a cap-bypass mechanism.

Core retention defaults apply (20-version floor, 100-version ceiling, 180-day
age target, no automatic expiry of deleted-note history), except in a vault that
received an operator history import (below), which keeps all its history.
History occupies the existing physical SQLite storage meter. A bounded
maintenance pass runs once when an instance loads state, without a new recurring
alarm. This does not promise immediate compaction of every edit on a long-lived
instance.

No Git archive import, mirror retirement or backfill runs in a Durable Object:
the archive is read on a self-hosted box, and Cloud only receives its result.

## Operator history import (T-450)

A person who moved from a self-hosted box can have the box's note history put
behind their notes on Cloud. The box runs core's `history-import apply` first;
the operator then sends each note's version rows, refs, receipt and blobs with
`scripts/ops-history-import.ts` (`local`, `plan`, `run`, `digest`, `finish`,
`status`; counts only). The doors:

- `POST /ops/history-import` (identity; bearer `OPS_RUN_TOKEN`): multipart. The
  address twice, a reference, the vault name, `dry_run`, the run id and the
  batch's counts as fields, and the batch's JSON as the file part `batch`. The
  account must be in good standing and own the vault. A batch that writes is
  audited first; the counts in that row are the ones the client stated
  (`stated_*`), since identity passes the batch's bytes to the vault without
  opening them, and the log line after the vault answers has its real totals.
  `/ops/history-import/status`, `/digest`, `/finish` take the same address,
  reference and vault, and forward to the vault; status and digest write no
  audit row.
- `POST /api/internal/history-import` (vault; platform only; `?dry_run=true` for
  a dry run, never inside the batch; `?run_id=`, which identity sends, must be
  the batch's run, so a batch that lands is the run its audit row names): checks
  the envelope (native indices, import indices and counts at most 10,000,000;
  times `Date.parse` reads; no blob over the engine's 2,000,000-byte version
  limit), verifies every blob by hash, then per note, in its own transaction:
  grafts only when the note's state on Cloud is the snapshot's (or the owner's
  oldest version is; a markdown body the export gave a final newline counts as
  the snapshot's), moves the owner's later versions above the box's native ones,
  and checks the grafted part's digest. A note already receipted by the same run
  is left exactly as it is, so a retry never brings back history the owner
  erased. Never changes a note's current state, marks the vault written, or
  fires hooks. Up to 16 MiB. `GET` answers counts; `/finish` marks the run
  complete at a receipt count.
- `POST /api/internal/history-digest`: per note, the history digest up to an
  index and whether every body reads back to its hash.

A vault that received a graft keeps all history (a DO-storage flag, applied on
every state load before maintenance): max 1,000,000 versions, 36,500 days, no
per-note byte ceiling. Its history then grows with every edit and counts against
the storage meter. The flag is set only by a batch that grafted at least one
note, in the same commit as its rows; a batch that grafts nothing, or is
refused, leaves no flag and no run behind (so `finish` of a run where every note
was refused finds no run: identity looks the run up before it audits, and the
client says there is nothing to do). No production run is part of this change.

The graft is not counted as the person writing, and internal routes skip the
plan's cap gate, so the door has its own: the whole batch runs in one
transaction, and when a cap is pushed and a batch that grafts a note (or grows
the database) would leave it above 90% of the notes cap, it is rolled back whole
and answered `413 history_import_over_cap` with the sizes. Batches before it
stay. A retry that grafts nothing and leaves the database the same size is
answered as usual. `plan` adds up each dry batch's growth and fails when the
projection passes 90% of the cap; `run` stops at that 413. No cap pushed, no
guard. A later `/ops/vault-import` retry would still replace the notes the
history sits behind.

Before a run: stop editing on the box after `apply` (its retention may prune
imported rows, and the client then refuses to send: `local` shows the count);
`plan` first. Then know these:

- Run in a quiet window, and have the person re-read a version list opened
  before the graft. When the owner already had versions of a note, the graft
  moves them up past the box's native ones, so an app still holding the old
  list can restore the wrong version by its index.
- A note refused as `note_changed` stays refused when the owner's oldest
  version on Cloud was pruned before the graft (default retention keeps 100):
  that version was the link to the box's state. There is no override.
- There is no un-graft door. The owner can erase a note's history
  (`DELETE /api/notes/:id/versions`); keep-all stays on.
- A receipt with `imported_count 0` marks a note that got only the box's native
  versions (it had no imported history).

## Browser bundle and validation

Cloud embeds the reviewed app history UI at App commit
`e9df2cd097e9384f37925adfcc0b1431fa621c09`, not a floating npm version.
That source still declares0.22.15-rc.2; the exact commit is the reproducibility
boundary and includes app#212 beyond the published rc.2 package. The standalone
app release is separate. The build validates the current @openparachute/app name
and runs the real origin-root build plus CSP generation.

The workerd probe covers one maintenance pass per ensureState load and two
concurrent administrator compaction loops with a sequential writer. Final
checks verify reconstructed hashes, depth-one deltas, referenced blobs and
foreign keys. This is concurrent request admission into one Durable Object,
not a forced internal interleaving or a multi-process SQLite test.
