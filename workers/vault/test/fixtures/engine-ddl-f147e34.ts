/**
 * The engine's DDL on a fresh SQLite file, as written by the ROLLBACK engine:
 * parachute-vault f147e34 core (the cloud's engine pin before cloud#329).
 * Generated under bun:sqlite: that engine's BunSqliteStore on `:memory:`, then
 * four notes that create the lazy link tables (an unresolved and an ambiguous
 * wikilink: "x [[Nowhere]]", A/Same, B/Same, "[[Same]]"), then
 *   SELECT type, name, tbl_name, sql FROM sqlite_master
 *   WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name
 * parachute-core 54475a5 and a9c9024 produce the identical list (checked when
 * this file was written). engine-upgrade.test.ts compares a fresh DO against
 * it: while they match, a rollback to f147e34 opens what the current engine
 * wrote. A pin bump that changes the DDL or SCHEMA_VERSION fails there and
 * must decide the rollback story before this fixture moves.
 */
export const ROLLBACK_ENGINE = "parachute-vault f147e34620322c53395d810b8496801ffa1748b3";
export const ROLLBACK_ENGINE_DDL: {
  schema_version: number;
  objects: { type: string; name: string; tbl_name: string; sql: string | null }[];
} =
{
 "schema_version": 32,
 "objects": [
  {
   "type": "index",
   "name": "idx_attachments_note",
   "tbl_name": "attachments",
   "sql": "CREATE INDEX idx_attachments_note ON attachments(note_id)"
  },
  {
   "type": "index",
   "name": "idx_history_compact_candidates",
   "tbl_name": "history_compact_state",
   "sql": "CREATE INDEX idx_history_compact_candidates ON history_compact_state(refused, stored DESC)"
  },
  {
   "type": "index",
   "name": "idx_links_source",
   "tbl_name": "links",
   "sql": "CREATE INDEX idx_links_source ON links(source_id)"
  },
  {
   "type": "index",
   "name": "idx_links_target",
   "tbl_name": "links",
   "sql": "CREATE INDEX idx_links_target ON links(target_id)"
  },
  {
   "type": "index",
   "name": "idx_mcp_mint_ledger_session",
   "tbl_name": "mcp_mint_ledger",
   "sql": "CREATE INDEX idx_mcp_mint_ledger_session ON mcp_mint_ledger(parent_jti, vault_name)"
  },
  {
   "type": "index",
   "name": "idx_note_blobs_delta_of",
   "tbl_name": "note_blobs",
   "sql": "CREATE INDEX idx_note_blobs_delta_of ON note_blobs(delta_of)"
  },
  {
   "type": "index",
   "name": "idx_note_tags_note",
   "tbl_name": "note_tags",
   "sql": "CREATE INDEX idx_note_tags_note ON note_tags(note_id, tag_name)"
  },
  {
   "type": "index",
   "name": "idx_note_tags_tag",
   "tbl_name": "note_tags",
   "sql": "CREATE INDEX idx_note_tags_tag ON note_tags(tag_name, note_id)"
  },
  {
   "type": "index",
   "name": "idx_note_vectors_stale",
   "tbl_name": "note_vectors",
   "sql": "CREATE INDEX idx_note_vectors_stale ON note_vectors(model, content_hash)"
  },
  {
   "type": "index",
   "name": "idx_note_versions_hash",
   "tbl_name": "note_versions",
   "sql": "CREATE INDEX idx_note_versions_hash ON note_versions(content_hash)"
  },
  {
   "type": "index",
   "name": "idx_note_versions_note",
   "tbl_name": "note_versions",
   "sql": "CREATE INDEX idx_note_versions_note ON note_versions(note_id, version_ix DESC)"
  },
  {
   "type": "index",
   "name": "idx_note_versions_note_hash",
   "tbl_name": "note_versions",
   "sql": "CREATE INDEX idx_note_versions_note_hash ON note_versions(note_id, content_hash)"
  },
  {
   "type": "index",
   "name": "idx_note_versions_superseded",
   "tbl_name": "note_versions",
   "sql": "CREATE INDEX idx_note_versions_superseded ON note_versions(superseded_at)"
  },
  {
   "type": "index",
   "name": "idx_notes_created",
   "tbl_name": "notes",
   "sql": "CREATE INDEX idx_notes_created ON notes(created_at)"
  },
  {
   "type": "index",
   "name": "idx_notes_created_by",
   "tbl_name": "notes",
   "sql": "CREATE INDEX idx_notes_created_by ON notes(created_by)"
  },
  {
   "type": "index",
   "name": "idx_notes_created_via",
   "tbl_name": "notes",
   "sql": "CREATE INDEX idx_notes_created_via ON notes(created_via)"
  },
  {
   "type": "index",
   "name": "idx_notes_last_updated_by",
   "tbl_name": "notes",
   "sql": "CREATE INDEX idx_notes_last_updated_by ON notes(last_updated_by)"
  },
  {
   "type": "index",
   "name": "idx_notes_last_updated_via",
   "tbl_name": "notes",
   "sql": "CREATE INDEX idx_notes_last_updated_via ON notes(last_updated_via)"
  },
  {
   "type": "index",
   "name": "idx_notes_path_ext_unique",
   "tbl_name": "notes",
   "sql": "CREATE UNIQUE INDEX idx_notes_path_ext_unique ON notes(path, extension) WHERE path IS NOT NULL"
  },
  {
   "type": "index",
   "name": "idx_notes_updated",
   "tbl_name": "notes",
   "sql": "CREATE INDEX idx_notes_updated ON notes(updated_at, id)"
  },
  {
   "type": "index",
   "name": "idx_notes_updated_ms",
   "tbl_name": "notes",
   "sql": "CREATE INDEX idx_notes_updated_ms ON notes(updated_at_ms, id)"
  },
  {
   "type": "index",
   "name": "idx_tokens_vault_name",
   "tbl_name": "tokens",
   "sql": "CREATE INDEX idx_tokens_vault_name ON tokens(vault_name)"
  },
  {
   "type": "table",
   "name": "ambiguous_wikilinks",
   "tbl_name": "ambiguous_wikilinks",
   "sql": "CREATE TABLE ambiguous_wikilinks (\n      source_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,\n      target_path TEXT NOT NULL COLLATE NOCASE,\n      relationship TEXT NOT NULL DEFAULT 'wikilink',\n      candidate_count INTEGER NOT NULL DEFAULT 0,\n      PRIMARY KEY (source_id, target_path, relationship)\n    )"
  },
  {
   "type": "table",
   "name": "attachments",
   "tbl_name": "attachments",
   "sql": "CREATE TABLE attachments (\n  id TEXT PRIMARY KEY,\n  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,\n  path TEXT NOT NULL,\n  mime_type TEXT NOT NULL,\n  metadata TEXT DEFAULT '{}',\n  created_at TEXT NOT NULL\n)"
  },
  {
   "type": "table",
   "name": "history_compact_state",
   "tbl_name": "history_compact_state",
   "sql": "CREATE TABLE history_compact_state (\n      note_id TEXT PRIMARY KEY, versions INTEGER NOT NULL, stored INTEGER NOT NULL,\n      live INTEGER NOT NULL, refused INTEGER NOT NULL DEFAULT 0, refreshed_at INTEGER NOT NULL\n    )"
  },
  {
   "type": "table",
   "name": "history_import_receipts",
   "tbl_name": "history_import_receipts",
   "sql": "CREATE TABLE history_import_receipts (\n      note_id TEXT PRIMARY KEY,\n      run_id TEXT NOT NULL REFERENCES history_import_runs(run_id),\n      state_digest TEXT NOT NULL,\n      imported_count INTEGER NOT NULL,\n      retained_count INTEGER NOT NULL,\n      pruned_imported INTEGER NOT NULL,\n      pruned_native INTEGER NOT NULL,\n      completed_at TEXT NOT NULL\n    )"
  },
  {
   "type": "table",
   "name": "history_import_refs",
   "tbl_name": "history_import_refs",
   "sql": "CREATE TABLE history_import_refs (\n      note_id TEXT NOT NULL REFERENCES history_import_receipts(note_id),\n      import_ix INTEGER NOT NULL CHECK(import_ix >= 0),\n      source_commit TEXT NOT NULL,\n      source_blob TEXT NOT NULL,\n      PRIMARY KEY(note_id, import_ix)\n    )"
  },
  {
   "type": "table",
   "name": "history_import_runs",
   "tbl_name": "history_import_runs",
   "sql": "CREATE TABLE history_import_runs (\n      run_id TEXT PRIMARY KEY,\n      source_fingerprint TEXT NOT NULL,\n      tip TEXT NOT NULL,\n      options_digest TEXT NOT NULL,\n      status TEXT NOT NULL CHECK(status IN ('applying', 'complete')),\n      created_at TEXT NOT NULL\n    )"
  },
  {
   "type": "table",
   "name": "indexed_fields",
   "tbl_name": "indexed_fields",
   "sql": "CREATE TABLE indexed_fields (\n  field TEXT PRIMARY KEY,\n  sqlite_type TEXT NOT NULL,\n  declarer_tags TEXT NOT NULL DEFAULT '[]'\n)"
  },
  {
   "type": "table",
   "name": "links",
   "tbl_name": "links",
   "sql": "CREATE TABLE links (\n  source_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,\n  target_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,\n  relationship TEXT NOT NULL,\n  metadata TEXT DEFAULT '{}',\n  created_at TEXT NOT NULL,\n  UNIQUE(source_id, target_id, relationship)\n)"
  },
  {
   "type": "table",
   "name": "mcp_mint_ledger",
   "tbl_name": "mcp_mint_ledger",
   "sql": "CREATE TABLE mcp_mint_ledger (\n  jti TEXT PRIMARY KEY,\n  parent_jti TEXT NOT NULL,\n  vault_name TEXT NOT NULL,\n  label TEXT NOT NULL,\n  scopes TEXT,\n  scoped_tags TEXT,\n  created_at TEXT NOT NULL,\n  expires_at TEXT,\n  revoked_at TEXT\n)"
  },
  {
   "type": "table",
   "name": "note_blobs",
   "tbl_name": "note_blobs",
   "sql": "CREATE TABLE note_blobs (\n  hash       TEXT PRIMARY KEY,\n  content    TEXT NOT NULL,\n  byte_size  INTEGER NOT NULL,\n  encoding TEXT,\n  delta_of TEXT REFERENCES note_blobs(hash)\n)"
  },
  {
   "type": "table",
   "name": "note_tags",
   "tbl_name": "note_tags",
   "sql": "CREATE TABLE note_tags (\n  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,\n  tag_name TEXT NOT NULL REFERENCES tags(name),\n  PRIMARY KEY (note_id, tag_name)\n)"
  },
  {
   "type": "table",
   "name": "note_vectors",
   "tbl_name": "note_vectors",
   "sql": "CREATE TABLE note_vectors (\n  note_id      TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,\n  chunk_ix     INTEGER NOT NULL DEFAULT 0,\n  vector       BLOB NOT NULL,\n  dims         INTEGER NOT NULL,\n  model        TEXT NOT NULL,\n  content_hash TEXT NOT NULL,\n  embedded_at  TEXT NOT NULL,\n  PRIMARY KEY (note_id, chunk_ix)\n)"
  },
  {
   "type": "table",
   "name": "note_versions",
   "tbl_name": "note_versions",
   "sql": "CREATE TABLE note_versions (\n  note_id       TEXT NOT NULL,\n  version_ix    INTEGER NOT NULL,\n  content_hash  TEXT REFERENCES note_blobs(hash),\n  path          TEXT,\n  metadata      TEXT,\n  extension     TEXT,\n  superseded_at TEXT NOT NULL,\n  actor         TEXT,\n  via           TEXT,\n  op            TEXT NOT NULL,\n  content_len   INTEGER NOT NULL,\n  encoding      TEXT,\n  created_at    TEXT,\n  PRIMARY KEY (note_id, version_ix)\n)"
  },
  {
   "type": "table",
   "name": "notes",
   "tbl_name": "notes",
   "sql": "CREATE TABLE notes (\n  id TEXT PRIMARY KEY,\n  content TEXT DEFAULT '',\n  path TEXT,\n  metadata TEXT DEFAULT '{}',\n  created_at TEXT NOT NULL,\n  updated_at TEXT,\n  extension TEXT NOT NULL DEFAULT 'md',\n  created_by TEXT,\n  created_via TEXT,\n  last_updated_by TEXT,\n  last_updated_via TEXT,\n  updated_at_ms INTEGER\n)"
  },
  {
   "type": "table",
   "name": "notes_fts",
   "tbl_name": "notes_fts",
   "sql": "CREATE VIRTUAL TABLE notes_fts USING fts5(\n  path,\n  content,\n  content='notes',\n  content_rowid='rowid',\n  tokenize='porter unicode61'\n)"
  },
  {
   "type": "table",
   "name": "notes_fts_config",
   "tbl_name": "notes_fts_config",
   "sql": "CREATE TABLE 'notes_fts_config'(k PRIMARY KEY, v) WITHOUT ROWID"
  },
  {
   "type": "table",
   "name": "notes_fts_data",
   "tbl_name": "notes_fts_data",
   "sql": "CREATE TABLE 'notes_fts_data'(id INTEGER PRIMARY KEY, block BLOB)"
  },
  {
   "type": "table",
   "name": "notes_fts_docsize",
   "tbl_name": "notes_fts_docsize",
   "sql": "CREATE TABLE 'notes_fts_docsize'(id INTEGER PRIMARY KEY, sz BLOB)"
  },
  {
   "type": "table",
   "name": "notes_fts_idx",
   "tbl_name": "notes_fts_idx",
   "sql": "CREATE TABLE 'notes_fts_idx'(segid, term, pgno, PRIMARY KEY(segid, term)) WITHOUT ROWID"
  },
  {
   "type": "table",
   "name": "oauth_clients",
   "tbl_name": "oauth_clients",
   "sql": "CREATE TABLE oauth_clients (\n  client_id TEXT PRIMARY KEY,\n  client_name TEXT,\n  redirect_uris TEXT,\n  created_at TEXT NOT NULL\n)"
  },
  {
   "type": "table",
   "name": "oauth_codes",
   "tbl_name": "oauth_codes",
   "sql": "CREATE TABLE oauth_codes (\n  code TEXT PRIMARY KEY,\n  client_id TEXT NOT NULL,\n  code_challenge TEXT NOT NULL,\n  code_challenge_method TEXT NOT NULL DEFAULT 'S256',\n  scope TEXT NOT NULL DEFAULT 'full',\n  redirect_uri TEXT NOT NULL,\n  expires_at TEXT NOT NULL,\n  used INTEGER NOT NULL DEFAULT 0,\n  created_at TEXT NOT NULL,\n  vault_name TEXT\n)"
  },
  {
   "type": "table",
   "name": "schema_version",
   "tbl_name": "schema_version",
   "sql": "CREATE TABLE schema_version (\n  version INTEGER PRIMARY KEY,\n  applied_at TEXT NOT NULL\n)"
  },
  {
   "type": "table",
   "name": "tags",
   "tbl_name": "tags",
   "sql": "CREATE TABLE tags (\n  name TEXT PRIMARY KEY,\n  description TEXT,\n  fields TEXT,\n  relationships TEXT,\n  parent_names TEXT,\n  created_at TEXT,\n  updated_at TEXT\n)"
  },
  {
   "type": "table",
   "name": "tokens",
   "tbl_name": "tokens",
   "sql": "CREATE TABLE tokens (\n  token_hash TEXT PRIMARY KEY,\n  label TEXT NOT NULL,\n  permission TEXT NOT NULL DEFAULT 'admin',\n  scopes TEXT,\n  scoped_tags TEXT,\n  scope_tag TEXT,\n  scope_path_prefix TEXT,\n  expires_at TEXT,\n  created_at TEXT NOT NULL,\n  last_used_at TEXT,\n  vault_name TEXT,\n  created_via TEXT,\n  parent_jti TEXT,\n  revoked_at TEXT\n)"
  },
  {
   "type": "table",
   "name": "triggers",
   "tbl_name": "triggers",
   "sql": "CREATE TABLE triggers (\n  name TEXT PRIMARY KEY,\n  events TEXT NOT NULL DEFAULT '[]',\n  \"when\" TEXT NOT NULL DEFAULT '{}',\n  action TEXT NOT NULL DEFAULT '{}',\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL\n)"
  },
  {
   "type": "table",
   "name": "unresolved_wikilinks",
   "tbl_name": "unresolved_wikilinks",
   "sql": "CREATE TABLE unresolved_wikilinks (\n      source_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,\n      target_path TEXT NOT NULL COLLATE NOCASE,\n      relationship TEXT NOT NULL DEFAULT 'wikilink',\n      PRIMARY KEY (source_id, target_path, relationship)\n    )"
  },
  {
   "type": "trigger",
   "name": "notes_fts_delete",
   "tbl_name": "notes",
   "sql": "CREATE TRIGGER notes_fts_delete AFTER DELETE ON notes BEGIN\n  INSERT INTO notes_fts(notes_fts, rowid, path, content) VALUES('delete', old.rowid, COALESCE(old.path, ''), old.content);\nEND"
  },
  {
   "type": "trigger",
   "name": "notes_fts_insert",
   "tbl_name": "notes",
   "sql": "CREATE TRIGGER notes_fts_insert AFTER INSERT ON notes BEGIN\n  INSERT INTO notes_fts(rowid, path, content) VALUES (new.rowid, COALESCE(new.path, ''), new.content);\nEND"
  },
  {
   "type": "trigger",
   "name": "notes_fts_update",
   "tbl_name": "notes",
   "sql": "CREATE TRIGGER notes_fts_update AFTER UPDATE OF content, path ON notes BEGIN\n  INSERT INTO notes_fts(notes_fts, rowid, path, content) VALUES('delete', old.rowid, COALESCE(old.path, ''), old.content);\n  INSERT INTO notes_fts(rowid, path, content) VALUES (new.rowid, COALESCE(new.path, ''), new.content);\nEND"
  }
 ]
};
