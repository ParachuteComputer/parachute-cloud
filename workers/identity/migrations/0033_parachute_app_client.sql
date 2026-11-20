-- 0033: the Parachute app's reserved client (T-476, cloud #421). The app (ParachuteComputer/parachute: Android, Mac)
-- signs in with client_id `parachute-app` instead of registering itself, so Cloud's Allow page names it "Parachute"
-- and doesn't call it unverified (oauth-connections.ts isVouchedClient: a reserved id no registration can claim, since
-- DCR always mints a random UUID). Before this, the app registered as "Vault app" (the name "Parachute" is reserved)
-- and every consent page said "Unverified app".
--
-- Its one return address is the app's own loopback catcher (src-tauri, port 47219). What stays true of any native app:
-- another program on the same device listening on that port while Parachute isn't could start a sign-in under this
-- id; the person still signs in and allows it on Cloud's own page, and the page says it returns to "an app on this
-- device". The same exposure the self-hosted names in oauth-register.ts already accept.
--
-- INSERT OR IGNORE: an operator-seeded row (or a later migration's) is never overwritten. Approved: no review queue.
INSERT OR IGNORE INTO clients (client_id, client_secret_hash, redirect_uris, scopes, client_name, registered_at, status, same_hub)
VALUES ('parachute-app', NULL, '["http://127.0.0.1:47219/oauth/callback"]', '', 'Parachute', '2026-11-20T00:00:00.000Z', 'approved', 0);
