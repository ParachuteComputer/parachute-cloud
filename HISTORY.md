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
This POST retains the hosted frozen/cap write gate; history erasure remains
available when capped, but manual compaction is not a cap-bypass mechanism.

Core retention defaults apply (20-version floor, 100-version ceiling, 180-day
age target, no automatic expiry of deleted-note history). History occupies the
existing physical SQLite storage meter. A bounded maintenance pass runs once
when an instance loads state, without a new recurring alarm. This does not
promise immediate compaction of every edit on a long-lived instance.

No Git archive import, mirror retirement or backfill runs in a Durable Object.
Imported selectors support already-present rows; they are not a hosted import
workflow. No production deployment is included in this change.

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
