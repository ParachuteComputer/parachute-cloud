/**
 * OAuth client registry (RFC 7591 DCR + the lookup side of authorize/token).
 * Port of the hub's `clients.ts` on D1.
 *
 * Public clients (PKCE-only): no secret, `client_secret_hash` NULL.
 * Confidential clients (`client_secret_post`): a random secret is minted, its
 * SHA-256 hex stored, the plaintext returned once.
 */
import { randomBase64url, randomUUID, sha256Hex, timingSafeEqualString } from "./crypto.ts";

export type ClientStatus = "pending" | "approved";

export interface OAuthClient {
  clientId: string;
  clientSecretHash: string | null;
  redirectUris: string[];
  scopes: string[];
  clientName: string | null;
  registeredAt: string;
  status: ClientStatus;
  sameHub: boolean;
}

interface Row {
  client_id: string;
  client_secret_hash: string | null;
  redirect_uris: string;
  scopes: string;
  client_name: string | null;
  registered_at: string;
  status: string;
  same_hub: number;
}

function rowToClient(r: Row): OAuthClient {
  return {
    clientId: r.client_id,
    clientSecretHash: r.client_secret_hash,
    redirectUris: JSON.parse(r.redirect_uris) as string[],
    scopes: r.scopes.split(" ").filter((s) => s.length > 0),
    clientName: r.client_name,
    registeredAt: r.registered_at,
    status: r.status === "approved" ? "approved" : "pending",
    sameHub: r.same_hub === 1,
  };
}

export class InvalidRedirectUriError extends Error {
  constructor(uri: string) {
    super(`redirect_uri "${uri}" is not registered for this client`);
    this.name = "InvalidRedirectUriError";
  }
}

export interface RegisterClientOpts {
  redirectUris: string[];
  scopes?: string[];
  clientName?: string;
  confidential?: boolean;
  clientId?: string;
  status?: ClientStatus;
  sameHub?: boolean;
  now?: () => Date;
}

export interface RegisteredClient {
  client: OAuthClient;
  /** Plaintext secret for confidential clients. NOT recoverable from the DB. */
  clientSecret: string | null;
}

export async function registerClient(db: D1Database, opts: RegisterClientOpts): Promise<RegisteredClient> {
  if (opts.redirectUris.length === 0) {
    throw new Error("registerClient: at least one redirect_uri is required");
  }
  for (const uri of opts.redirectUris) {
    if (!isValidRedirectUri(uri)) throw new Error(`registerClient: invalid redirect_uri "${uri}"`);
  }
  const clientId = opts.clientId ?? randomUUID();
  const clientSecret = opts.confidential ? randomBase64url(32) : null;
  const clientSecretHash = clientSecret ? await sha256Hex(clientSecret) : null;
  const registeredAt = (opts.now?.() ?? new Date()).toISOString();
  const scopes = (opts.scopes ?? []).join(" ");
  const status: ClientStatus = opts.status ?? "approved";
  const sameHub = opts.sameHub ?? false;
  await db
    .prepare(
      `INSERT INTO clients
       (client_id, client_secret_hash, redirect_uris, scopes, client_name, registered_at, status, same_hub)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      clientId,
      clientSecretHash,
      JSON.stringify(opts.redirectUris),
      scopes,
      opts.clientName ?? null,
      registeredAt,
      status,
      sameHub ? 1 : 0,
    )
    .run();
  return {
    client: {
      clientId,
      clientSecretHash,
      redirectUris: opts.redirectUris,
      scopes: opts.scopes ?? [],
      clientName: opts.clientName ?? null,
      registeredAt,
      status,
      sameHub,
    },
    clientSecret,
  };
}

export async function getClient(db: D1Database, clientId: string): Promise<OAuthClient | null> {
  const row = await db.prepare("SELECT * FROM clients WHERE client_id = ?").bind(clientId).first<Row>();
  return row ? rowToClient(row) : null;
}

/** Promote a `pending` client to `approved`. Idempotent. */
export async function approveClient(db: D1Database, clientId: string): Promise<void> {
  await db.prepare("UPDATE clients SET status = 'approved' WHERE client_id = ?").bind(clientId).run();
}

/** RFC 8252/6749 exact-match — no wildcards, no loose comparison. */
export function requireRegisteredRedirectUri(client: OAuthClient, candidate: string): string {
  if (!client.redirectUris.includes(candidate)) throw new InvalidRedirectUriError(candidate);
  return candidate;
}

export async function verifyClientSecret(client: OAuthClient, presented: string): Promise<boolean> {
  if (!client.clientSecretHash) return false;
  const presentedHash = await sha256Hex(presented);
  return timingSafeEqualString(client.clientSecretHash, presentedHash);
}

/**
 * Dotless private-use schemes accepted anyway, because a real MCP client
 * registers them: xAI's Grok Bot sends `cursor://anysphere.cursor-mcp/oauth/
 * callback` next to its https callback (T-307). Add one only with evidence of
 * a client that uses it.
 */
const KNOWN_NATIVE_SCHEMES = new Set(["cursor"]);

/**
 * A native app's private-use URI scheme redirect (RFC 8252 §7.1), held to
 * what OAuth 2.1 (draft-13 §2.3.1) asks of one: a reverse-domain scheme, so
 * one containing a period, or a dotless scheme a known MCP client uses
 * ({@link KNOWN_NATIVE_SCHEMES}). Browser-internal and network schemes have no
 * period and are not known clients, so they stay refused. No fragment
 * (RFC 6749 §3.1.2) and something after the scheme. PKCE S256 is mandatory
 * at authorize, which is what keeps another app claiming the same scheme from
 * spending an intercepted code (RFC 8252 §8.1).
 */
function isPrivateUseRedirect(u: URL): boolean {
  const scheme = u.protocol.slice(0, -1);
  if (!/^[a-z][a-z0-9+.-]*$/.test(scheme)) return false;
  if (!scheme.includes(".") && !KNOWN_NATIVE_SCHEMES.has(scheme)) return false;
  if (u.hash !== "" || u.href.includes("#")) return false;
  return u.host !== "" || (u.pathname !== "" && u.pathname !== "/");
}

/** A redirect URI that is not http(s): a native app's private-use scheme, shown on the consent page. */
export function isNativeAppRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    return u.protocol !== "http:" && u.protocol !== "https:";
  } catch {
    return false;
  }
}

/**
 * True when every redirect URI lands on a first-party origin (the issuer or a
 * BOUND_ORIGINS member, as `firstPartyOrigins`): the token can only go back to
 * a Parachute page. A private-use scheme has no web origin, so never counts.
 * Used to decide whether a registration may carry a Parachute-like name
 * (oauth-register.ts) and whether consent labels the app unverified.
 */
export function redirectsAreFirstParty(redirectUris: readonly string[], firstPartyOrigins: readonly string[]): boolean {
  if (redirectUris.length === 0) return false;
  return redirectUris.every((uri) => {
    try {
      const u = new URL(uri);
      return (u.protocol === "https:" || u.protocol === "http:") && firstPartyOrigins.includes(u.origin);
    } catch {
      return false;
    }
  });
}

/**
 * Whether Parachute can vouch for this client on the Allow screen: it was
 * registered by a signed-in Parachute page (bound-origin auto-approve,
 * `sameHub`), or it can only send you back to Parachute's own origins.
 * Everything else registered itself (RFC 7591 DCR) and is shown as unverified.
 */
export function isVouchedClient(client: OAuthClient, firstPartyOrigins: readonly string[]): boolean {
  return client.sameHub || redirectsAreFirstParty(client.redirectUris, firstPartyOrigins);
}

/**
 * Light validation — refuses obviously-wrong shapes (relative paths,
 * javascript:/data: URIs, embedded control chars, userinfo). http(s), or a
 * native app's private-use scheme ({@link isPrivateUseRedirect}).
 * Registration-time hygiene; exact-match against the registered set is
 * `requireRegisteredRedirectUri`.
 */
export function isValidRedirectUri(uri: string): boolean {
  for (let i = 0; i < uri.length; i++) {
    const c = uri.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return false;
  }
  try {
    const u = new URL(uri);
    if (u.protocol === "javascript:" || u.protocol === "data:") return false;
    if (u.username !== "" || u.password !== "") return false;
    if (u.protocol === "http:" || u.protocol === "https:") return true;
    return isPrivateUseRedirect(u);
  } catch {
    return false;
  }
}
