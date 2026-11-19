/**
 * POST /oauth/revoke — RFC 7009 token revocation. Always 200 on success OR
 * unknown token (§2.2 — no existence disclosure). Tries the refresh-token hash
 * first (the common case), then falls back to an unverified JWT-jti decode for
 * access tokens. A token owned by a different client is collapsed to 200 with
 * the row left live and nothing else changed.
 *
 * Revoking a live token also takes back the grant behind it, per vault scope
 * (RFC 7009 §2.1, "the underlying authorization grant"): each
 * `vault:<name>:<verb>` it carried that no other live token of the same user
 * and client still carries leaves the (user, client) grant, so the next ask
 * for it shows the consent page again (`dropVaultScopesNoLiveTokenHolds`).
 * The token revocation runs first and on its own; the grant step is best
 * effort and never changes the 200.
 */
import { getClient, verifyClientSecret, type OAuthClient } from "./clients.ts";
import { dropVaultScopesNoLiveTokenHolds } from "./grants.ts";
import { findRefreshToken, findTokenRowByJti, type RefreshTokenRow } from "./tokens.ts";
import { type OAuthDeps, jsonResponse } from "./oauth-shared.ts";

function extractClientCredentials(req: Request, form: FormData): { headerClientId: string | null; clientSecret: string | null } {
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Basic ")) {
    try {
      const decoded = atob(auth.slice("Basic ".length));
      const idx = decoded.indexOf(":");
      if (idx >= 0) return { headerClientId: decoded.slice(0, idx), clientSecret: decoded.slice(idx + 1) };
    } catch {
      // fall through
    }
  }
  const secret = form.get("client_secret");
  return { headerClientId: null, clientSecret: typeof secret === "string" && secret ? secret : null };
}

async function authenticateClient(
  client: OAuthClient,
  req: Request,
  form: FormData,
  bodyClientId: string,
): Promise<Response | null> {
  if (!client.clientSecretHash) return null;
  const { headerClientId, clientSecret } = extractClientCredentials(req, form);
  if (!clientSecret) return jsonResponse({ error: "invalid_client", error_description: "client_secret required for confidential client" }, 401);
  if (headerClientId !== null && headerClientId !== bodyClientId) {
    return jsonResponse({ error: "invalid_client", error_description: "authorization header client_id does not match request body" }, 401);
  }
  if (!(await verifyClientSecret(client, clientSecret))) {
    return jsonResponse({ error: "invalid_client", error_description: "client_secret mismatch" }, 401);
  }
  return null;
}

function unverifiedJtiOf(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const payload = parts[1];
  if (!payload) return null;
  try {
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const json = JSON.parse(atob(b64)) as { jti?: unknown };
    return typeof json.jti === "string" ? json.jti : null;
  } catch {
    return null;
  }
}

export async function handleRevoke(db: D1Database, req: Request, _deps: OAuthDeps): Promise<Response> {
  // Same malformed-body guard as handleToken: a throw here would skip the
  // route-level wildcard-CORS wrapper (#35).
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return jsonResponse(
      { error: "invalid_request", error_description: "request body must be application/x-www-form-urlencoded" },
      400,
    );
  }
  const token = String(form.get("token") ?? "");
  const hint = String(form.get("token_type_hint") ?? "");
  const bodyClientId = String(form.get("client_id") ?? "");
  if (!token || !bodyClientId) {
    return jsonResponse({ error: "invalid_request", error_description: "missing required parameter" }, 400);
  }
  const client = await getClient(db, bodyClientId);
  if (!client) return jsonResponse({ error: "invalid_client", error_description: "unknown client_id" }, 401);
  const authFailure = await authenticateClient(client, req, form, bodyClientId);
  if (authFailure) return authFailure;

  const now = new Date();
  let row: RefreshTokenRow | null = hint === "access_token" ? null : await findRefreshToken(db, token);
  if (!row) {
    const jti = unverifiedJtiOf(token);
    if (jti) row = await findTokenRowByJti(db, jti);
    if (!row && hint === "access_token") row = await findRefreshToken(db, token);
  }
  if (row && row.clientId !== client.clientId) {
    // Different client — collapse to 200 (no existence disclosure).
    return new Response(null, { status: 200 });
  }
  if (row && !row.revokedAt) {
    await db.prepare("UPDATE tokens SET revoked_at = ? WHERE jti = ?").bind(now.toISOString(), row.jti).run();
    // No first-party exemption here (unlike the Connected apps list and
    // Disconnect): this is the client giving back its own token, and the
    // Parachute app is exactly the client that asks per vault and revokes.
    if (row.userId && row.expiresAt > now.toISOString()) {
      try {
        const dropped = await dropVaultScopesNoLiveTokenHolds(db, row.userId, row.clientId, row.jti, row.scopes, now);
        // Ids and a count only: no scopes, no token material.
        if (dropped.length > 0) {
          console.log(`event=grant_narrowed_on_revoke user=${row.userId} client=${row.clientId} dropped=${dropped.length}`);
        }
      } catch (err) {
        console.error(`event=grant_narrow_on_revoke_failed client=${row.clientId} error=${err instanceof Error ? err.name : "unknown"}`);
      }
    }
  }
  return new Response(null, { status: 200 });
}
