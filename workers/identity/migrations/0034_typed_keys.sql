-- T-476 (typed keys, core #140/#143/#144): a key may be held to some types of its vault, and says what it is for.
--   types: the JSON list of types a one-vault key is held to (its grant, filed at the vault, holds the rules); NULL for
--          a key that reaches the whole vault, which every key made before this is.
--   kind:  'agent' for a key made for an AI, else NULL (an app). The key's token carries it in its `key` claim.
-- Both nullable and additive: an older worker never reads them, and a rollback leaves them in place.
ALTER TABLE app_keys ADD COLUMN types TEXT;
ALTER TABLE app_keys ADD COLUMN kind TEXT;
