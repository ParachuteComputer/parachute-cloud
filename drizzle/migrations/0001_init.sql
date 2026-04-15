-- Parachute Cloud — initial accounts schema.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  clerk_user_id TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  tier TEXT NOT NULL DEFAULT 'free',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS vaults (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  hostname TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS vaults_owner_idx ON vaults(owner_user_id);

CREATE TABLE IF NOT EXISTS hostnames (
  hostname TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL REFERENCES vaults(id),
  cf_custom_hostname_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  stripe_customer_id TEXT NOT NULL,
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
