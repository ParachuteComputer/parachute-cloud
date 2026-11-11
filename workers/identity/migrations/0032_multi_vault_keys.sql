-- 0032: multi-vault keys (T-446, Parachute 0.9.1 "one multi-vault door"). One additive, nullable column; nothing
-- existing changes, and no existing row is rewritten.
--
-- app_keys.vaults  NULL for every one-vault key (as before). For a key minted with `POST /account/keys
--                  {name, vaults: {<vault>: "read"|"write"}}` it holds that map as JSON; such a key's token has
--                  `aud=account` and opens only the account door (`/account/mcp`), each vault at its own level.
--                  Its `vault_name` is '*', which no vault can be named (vault names are lowercase letters, digits
--                  and '-'), so the one-vault paths keyed on `vault_name` (the handover's key revocation, the
--                  last-use and revoke pushes to a vault) never match it. Its `can` is its highest level.
ALTER TABLE app_keys ADD COLUMN vaults TEXT;
