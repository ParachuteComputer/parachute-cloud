/**
 * Discovery endpoints:
 *   - /.well-known/oauth-authorization-server  (RFC 8414 AS metadata)
 *   - /.well-known/oauth-protected-resource    (RFC 9728 PRM)
 *   - /.well-known/jwks.json                    (RS256 public keys)
 *   - /.well-known/parachute-revocation.json    (revoked-jti list, 60s cache)
 *
 * All are public + wildcard-CORS (cross-origin browser fetches + resource-server
 * polling read them). Shapes match the hub byte-for-byte.
 */
import { getActiveSigningKey, getAllPublicKeys, pemToJwk } from "./signing-keys.ts";
import { listActiveRevocations } from "./tokens.ts";
import { type OAuthDeps, jsonResponse } from "./oauth-shared.ts";

/**
 * Scopes advertised in `scopes_supported`. Cloud v1 is data-only: clients
 * request the unnamed `vault:read`/`vault:write` and the flow narrows to a
 * named vault via `resource=`/`vault=`. Operator-only admin scopes are absent
 * (RFC 8414 §2 — advertise only what a client may request).
 */
export const ADVERTISED_SCOPES = ["vault:read", "vault:write"];

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
};

export function corsPreflight(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

export function authorizationServerMetadata(deps: OAuthDeps): Response {
  const iss = deps.issuer;
  return jsonResponse(
    {
      issuer: iss,
      authorization_endpoint: `${iss}/oauth/authorize`,
      token_endpoint: `${iss}/oauth/token`,
      registration_endpoint: `${iss}/oauth/register`,
      revocation_endpoint: `${iss}/oauth/revoke`,
      jwks_uri: `${iss}/.well-known/jwks.json`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
      scopes_supported: ADVERTISED_SCOPES,
    },
    200,
    CORS,
  );
}

export function protectedResourceMetadata(deps: OAuthDeps): Response {
  const iss = deps.issuer;
  return jsonResponse(
    {
      resource: iss,
      authorization_servers: [iss],
      scopes_supported: ADVERTISED_SCOPES,
      bearer_methods_supported: ["header"],
      resource_documentation: "https://parachute.computer",
    },
    200,
    CORS,
  );
}

export async function handleJwks(db: D1Database): Promise<Response> {
  // Ensure the active key exists so a resource server that fetches JWKS before
  // the issuer's first token-mint still gets a key to cache (generate-on-empty).
  await getActiveSigningKey(db);
  const keys = await Promise.all(
    (await getAllPublicKeys(db)).map((k) => pemToJwk(k.publicKeyPem, k.kid)),
  );
  return jsonResponse({ keys }, 200, CORS);
}

export const REVOCATION_LIST_CACHE_SECONDS = 60;

export async function handleRevocationList(db: D1Database, deps: OAuthDeps): Promise<Response> {
  const now = deps.now?.() ?? new Date();
  const jtis = await listActiveRevocations(db, now);
  return jsonResponse({ generated_at: now.toISOString(), jtis }, 200, {
    ...CORS,
    "cache-control": `public, max-age=${REVOCATION_LIST_CACHE_SECONDS}`,
  });
}
