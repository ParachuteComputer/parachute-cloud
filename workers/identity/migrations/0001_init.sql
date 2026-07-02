-- Identity Worker control-plane schema.
--
-- Table shapes mirror the hub's hub.db (signing_keys / clients / auth_codes /
-- tokens / grants) so the issuer logic ports 1:1 and the conformance corpus can
-- assert identical wire behavior. `users` is keyed by email (the cloud login
-- identifier) and `sessions` backs the login cookie. Timestamps are ISO-8601
-- strings — they sort lexicographically, so `expires_at > ?now` comparisons are
-- correct string comparisons, exactly as in the hub.

-- RSA-2048 signing keys backing JWT issuance + the JWKS endpoint. One active
-- key (retired_at IS NULL) at a time; kid = base64url(SHA-256(public_key_pem)).
CREATE TABLE signing_keys (
  kid              TEXT PRIMARY KEY,
  public_key_pem   TEXT NOT NULL,
  private_key_pem  TEXT NOT NULL,
  algorithm        TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  retired_at       TEXT
);

-- Cloud-account users. Email is the login identifier; password_hash is a
-- PBKDF2-SHA256 verifier (WebCrypto — see DIVERGENCE note in users.ts).
CREATE TABLE users (
  id             TEXT PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash  TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

-- Login sessions (the browser cookie). Distinct from OAuth tokens.
CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions (user_id);

-- OAuth clients (RFC 7591 DCR). Public (PKCE-only, secret hash NULL) or
-- confidential (client_secret_post). status pending|approved; same_hub marks
-- an operator-registered client.
CREATE TABLE clients (
  client_id           TEXT PRIMARY KEY,
  client_secret_hash  TEXT,
  redirect_uris       TEXT NOT NULL,   -- JSON array
  scopes              TEXT NOT NULL DEFAULT '',
  client_name         TEXT,
  registered_at       TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending',
  same_hub            INTEGER NOT NULL DEFAULT 0
);

-- Short-lived authorization codes for the `code` grant. PKCE S256 mandatory.
CREATE TABLE auth_codes (
  code                  TEXT PRIMARY KEY,
  client_id             TEXT NOT NULL,
  user_id               TEXT NOT NULL,
  redirect_uri          TEXT NOT NULL,
  scopes                TEXT NOT NULL,
  code_challenge        TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL,
  expires_at            TEXT NOT NULL,
  used_at               TEXT,
  created_at            TEXT NOT NULL
);
CREATE INDEX idx_auth_codes_client ON auth_codes (client_id);

-- The unified token registry. Refresh-token rows (created_via='oauth_refresh')
-- carry refresh_token_hash + family_id; rotation links predecessor→successor
-- via rotated_to. Revocation list derives from this table.
CREATE TABLE tokens (
  jti                 TEXT PRIMARY KEY,
  user_id             TEXT,
  subject             TEXT,
  client_id           TEXT NOT NULL,
  scopes              TEXT NOT NULL,
  refresh_token_hash  TEXT,
  family_id           TEXT,
  expires_at          TEXT NOT NULL,
  revoked_at          TEXT,
  created_at          TEXT NOT NULL,
  created_via         TEXT NOT NULL DEFAULT 'oauth_refresh',
  permissions         TEXT,
  rotated_to          TEXT
);
CREATE INDEX idx_tokens_refresh_hash ON tokens (refresh_token_hash);
CREATE INDEX idx_tokens_family ON tokens (family_id);
CREATE INDEX idx_tokens_client ON tokens (client_id);
CREATE INDEX idx_tokens_revocation ON tokens (revoked_at, expires_at);

-- Standing consent: "user U approved scope-set S for client C". UNION-merged.
CREATE TABLE grants (
  user_id     TEXT NOT NULL,
  client_id   TEXT NOT NULL,
  scopes      TEXT NOT NULL,
  granted_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, client_id)
);
