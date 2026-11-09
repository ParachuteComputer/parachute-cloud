/**
 * The canary vault (L6-03). Every other health signal stops at the vault
 * worker's router (`/health` never wakes a DO), so a vault Durable Object that
 * fails to boot after a deploy (`bootError`, e.g. NewerSchemaError) answered
 * every client with a 500 that nothing saw until the next night. The canary is
 * one staff-owned vault that is read the way a client reads it:
 *
 *   - the 10-minute health cron (ops.ts runHealthCheck) mints a read-only JWT
 *     for that vault (the same signAccessToken a client's OAuth token comes
 *     from; `vault:<name>:read`, `aud` vault.<name>, 60 s, client_id
 *     {@link CANARY_CLIENT_ID}, never first-party) and spends it through the
 *     vault worker (service binding when bound, else VAULT_ORIGIN), on one REST
 *     note read and one MCP `tools/list` (canary-probe.ts). A failure is a
 *     `vault-canary` health failure on the cron's own alert path.
 *   - POST /ops/canary-token (bearer OPS_CANARY_TOKEN) hands an external
 *     checker (scripts/uptime-check.sh) the same kind of token for 5 minutes,
 *     so it can make the same two requests from outside Cloudflare.
 *
 * Config: CANARY_VAULT_NAME ([vars]; unset or blank = no canary, the cron logs
 * one skip line), CANARY_NOTE (the note's path or id; default "canary").
 * The canary vault must be owned by an operator account (users.role): a typo
 * that names someone's real vault is refused, never read. There is no stored
 * vault credential: cloud vaults accept only issuer-signed JWTs, and this
 * worker is the issuer. Setup and the uptime plan: docs/UPTIME.md.
 */
import { probeCanaryVault, type CanarySend } from "./canary-probe.ts";
import type { Env } from "./env.ts";
import { type OAuthDeps, vaultInstanceUrl } from "./oauth-shared.ts";
import { opsBearerRefusal } from "./ops-daily.ts";
import { signAccessToken } from "./tokens.ts";
import { getUserById } from "./users.ts";
import { callVaultApi } from "./vault-call.ts";
import { type Vault, getVault } from "./vaults.ts";

/** `client_id` on canary tokens: a tenant-shaped id, so the vault's first-party internal seam refuses it. */
export const CANARY_CLIENT_ID = "parachute-canary";
export const DEFAULT_CANARY_NOTE = "canary";
/** Lifetime of a token handed to an external checker: one check, with retries. */
export const CANARY_TOKEN_TTL_SECONDS = 300;

export interface CanaryConfig {
  vault: string;
  note: string;
}

/** The configured canary, or null when CANARY_VAULT_NAME is unset or blank. */
export function canaryConfig(env: Pick<Env, "CANARY_VAULT_NAME" | "CANARY_NOTE">): CanaryConfig | null {
  const vault = env.CANARY_VAULT_NAME?.trim().toLowerCase();
  if (!vault) return null;
  return { vault, note: env.CANARY_NOTE?.trim() || DEFAULT_CANARY_NOTE };
}

/** The canary's D1 row, if it exists and an operator owns it; else why not. */
async function canaryVault(db: D1Database, cfg: CanaryConfig): Promise<{ vault: Vault } | { refused: string }> {
  const vault = await getVault(db, cfg.vault);
  if (!vault) return { refused: `canary vault "${cfg.vault}" has no row in identity D1 (CANARY_VAULT_NAME)` };
  const owner = await getUserById(db, vault.ownerUserId);
  if (owner?.role !== "operator") {
    return { refused: `canary vault "${cfg.vault}" is not owned by an operator account; refusing to read it` };
  }
  return { vault };
}

/**
 * The cron's canary check: `null` = healthy, else the reason. Never throws.
 * `deps` carries the issuer + the vault transport (depsForEnv; the cron
 * injects a fetch only in tests).
 */
export async function runCanaryCheck(db: D1Database, deps: OAuthDeps, cfg: CanaryConfig): Promise<string | null> {
  try {
    const target = await canaryVault(db, cfg);
    if ("refused" in target) return target.refused;
    const { vault } = target;
    const send: CanarySend = (method, apiPath, init) =>
      callVaultApi(db, deps, {
        userId: vault.ownerUserId,
        vaultName: vault.name,
        method,
        apiPath,
        verb: "read",
        clientId: CANARY_CLIENT_ID,
        extraHeaders: init.headers,
        ...(init.json !== undefined ? { jsonBody: init.json } : {}),
        signal: init.signal,
      });
    return await probeCanaryVault(send, cfg.note);
  } catch (err) {
    return `canary check threw: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`;
  }
}

/**
 * POST /ops/canary-token — a 5-minute read-only token for the canary vault,
 * and where to spend it, for an external checker. Bearer OPS_CANARY_TOKEN
 * (its own secret: its holder can read the canary vault and nothing else);
 * unset → null (the router's 404). The vault is the server's [vars] choice,
 * never the caller's.
 */
export async function handleOpsCanaryToken(env: Env, req: Request, deps: OAuthDeps): Promise<Response | null> {
  const refused = await opsBearerRefusal(env.OPS_CANARY_TOKEN, req);
  if (refused !== undefined) return refused;
  const noStore = { "cache-control": "no-store" };
  const cfg = canaryConfig(env);
  if (!cfg) return Response.json({ error: "canary_not_configured" }, { status: 404, headers: noStore });
  const target = await canaryVault(env.DB, cfg);
  if ("refused" in target) {
    console.error(`event=ops_canary_token_refused detail=${JSON.stringify(target.refused)}`);
    return Response.json({ error: "canary_unavailable", detail: target.refused }, { status: 409, headers: noStore });
  }
  const signed = await signAccessToken(env.DB, {
    sub: target.vault.ownerUserId,
    scopes: [`vault:${target.vault.name}:read`],
    audience: `vault.${target.vault.name}`,
    clientId: CANARY_CLIENT_ID,
    issuer: deps.issuer,
    vaultScope: [target.vault.name],
    ttlSeconds: CANARY_TOKEN_TTL_SECONDS,
    now: deps.now,
  });
  console.log(`event=ops_canary_token_minted expires_in=${CANARY_TOKEN_TTL_SECONDS}`);
  return Response.json(
    {
      vault_token: signed.token,
      expires_in: CANARY_TOKEN_TTL_SECONDS,
      vault_url: vaultInstanceUrl(target.vault.name, deps),
      note: cfg.note,
    },
    { headers: noStore },
  );
}
