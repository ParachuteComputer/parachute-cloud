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
 * Light validation — refuses obviously-wrong shapes (relative paths,
 * javascript:/data: URIs, embedded control chars, userinfo). Registration-time
 * hygiene; exact-match against the registered set is `requireRegisteredRedirectUri`.
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
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}
