-- Parachute Cloud — v0.4 user-per-subdomain schema.
--
-- Identity shape: one hostname per user, many vaults under that hostname
-- addressed by slug (`<user>.parachute.computer/v/<slug>/...`). Tokens live
-- in D1 and are either user-scoped (access every vault the user owns) or
-- vault-scoped (just one slug). See Uni/Decisions/2026-04-15-parachute-cloud-user-per-subdomain.
--
-- Named 0002 rather than 0001 so `wrangler d1 migrations apply --local` still
-- runs on machines that executed the v0.3 0001_init.sql: wrangler's tracker
-- has already marked 0001_init done, so re-editing that file in place would
-- be skipped. A fresh filename fires the DROPs + re-creates below once and
-- settles on the v0.4 shape. On pristine machines the DROPs are harmless.

DROP TABLE IF EXISTS usage_events;
DROP TABLE IF EXISTS subscriptions;
DROP TABLE IF EXISTS tokens;
DROP TABLE IF EXISTS vaults;
DROP TABLE IF EXISTS hostnames;
DROP TABLE IF EXISTS custom_hostnames;  -- v0.3 only, gone in v0.4
DROP TABLE IF EXISTS users;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  clerk_user_id TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  hostname TEXT UNIQUE,               -- null until the user picks one at onboarding
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS users_hostname_idx ON users(hostname);

CREATE TABLE IF NOT EXISTS hostnames (
  hostname TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  cf_custom_hostname_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS vaults (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  slug TEXT NOT NULL,                 -- URL-safe, unique per user
  name TEXT NOT NULL,                 -- display name
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  UNIQUE(user_id, slug)
);
CREATE INDEX IF NOT EXISTS vaults_user_idx ON vaults(user_id);

CREATE TABLE IF NOT EXISTS tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  vault_slug TEXT,                    -- null = access all of user's vaults
  token_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS tokens_user_idx ON tokens(user_id);
CREATE INDEX IF NOT EXISTS tokens_hash_idx ON tokens(token_hash);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  stripe_customer_id TEXT NOT NULL UNIQUE,
  stripe_subscription_id TEXT,
  status TEXT NOT NULL,
  tier TEXT NOT NULL,
  current_period_end INTEGER
);
CREATE INDEX IF NOT EXISTS subs_user_idx ON subscriptions(user_id);

CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL REFERENCES vaults(id),
  kind TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  occurred_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_vault_idx ON usage_events(vault_id, occurred_at);
