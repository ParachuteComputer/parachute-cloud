/**
 * App keys at the vault (T-414, Parachute 0.9.1): what one vault's Durable Object knows about the named,
 * long-lived keys its owner minted for apps at the identity worker (`/account/keys`, client_id
 * `parachute-app-key`, one vault, read or write, never admin).
 *
 *   - **Revoked here, refused now.** When the owner revokes a key, identity tells this vault's DO
 *     (`POST /api/internal/keys/revoke`, first-party only) and the DO refuses that jti on its very next request,
 *     on every door (REST, MCP, the landing, the WS socket). The public revocation list still carries the jti
 *     (every isolate's 60 s cache picks it up), so a failed push only delays the refusal to that minute. Kept
 *     until the key would have expired anyway, then dropped.
 *   - **Last use.** Each authenticated request with an app key notes the time, written to storage at most once a
 *     minute per key (a busy Arcade worker costs one row write a minute, not one per reaction). Identity reads it
 *     back (`GET /api/internal/keys/used`) when the owner lists their keys.
 *
 * Both live in DO key-value storage (two keys), never in the vault's SQLite: the vault's schema, table count and
 * exports don't change (the health-counter rule).
 */
export const APP_KEY_CLIENT_ID = "parachute-app-key";
export const KEY_USE_INTERVAL_MS = 60_000;
const REVOKED_KEY = "app_keys_revoked";
const USED_KEY = "app_keys_used";

export class AppKeyLedger {
  private revoked: Record<string, string> | null = null; // jti → expires_at (ISO)
  private used: Record<string, string> | null = null; // jti → last used (ISO)

  constructor(private readonly storage: DurableObjectStorage) {}

  private async revokedMap(): Promise<Record<string, string>> {
    this.revoked ??= (await this.storage.get<Record<string, string>>(REVOKED_KEY)) ?? {};
    return this.revoked;
  }

  private async usedMap(): Promise<Record<string, string>> {
    this.used ??= (await this.storage.get<Record<string, string>>(USED_KEY)) ?? {};
    return this.used;
  }

  async isRevoked(jti: string): Promise<boolean> {
    return jti in (await this.revokedMap());
  }

  /** Record a revocation (idempotent). Entries past their key's expiry are dropped: the JWT's own `exp` refuses those. */
  async revoke(jti: string, expiresAt: string, now: Date = new Date()): Promise<void> {
    const map = await this.revokedMap();
    const stamp = now.toISOString();
    for (const [k, exp] of Object.entries(map)) if (exp <= stamp) delete map[k];
    map[jti] = expiresAt;
    await this.storage.put(REVOKED_KEY, map);
    const used = await this.usedMap();
    if (jti in used) {
      delete used[jti];
      await this.storage.put(USED_KEY, used);
    }
  }

  /** Note that `jti` was just used; one storage write per key per minute at most. */
  async noteUse(jti: string, now: Date = new Date()): Promise<void> {
    const used = await this.usedMap();
    const last = used[jti];
    if (last && now.getTime() - Date.parse(last) < KEY_USE_INTERVAL_MS) return;
    used[jti] = now.toISOString();
    await this.storage.put(USED_KEY, used);
  }

  async lastUsed(): Promise<Record<string, string>> {
    return { ...(await this.usedMap()) };
  }
}
