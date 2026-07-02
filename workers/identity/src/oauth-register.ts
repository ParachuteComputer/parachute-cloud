/**
 * POST /oauth/register — RFC 7591 Dynamic Client Registration.
 *
 * `token_endpoint_auth_method: "none"` (public/PKCE) and `"client_secret_post"`
 * (confidential) are supported. New rows land `pending`; a same-origin request
 * carrying a valid operator session auto-approves (`approved` + `same_hub`). All
 * other registrations stay `pending` and are auto-approved later by the
 * single-consent authorize flow. Response is the RFC 7591 client-information
 * shape (201).
 *
 * SIMPLIFICATION vs hub (documented): the hub also has an operator-bearer
 * (`hub:admin`) path and a first-client wizard window. The cloud Identity Worker
 * has no operator token of its own and no install wizard, so those paths are
 * omitted; the session path + single-consent authorize cover approval.
 */
import { type ClientStatus, type RegisteredClient, isValidRedirectUri, registerClient } from "./clients.ts";
import { findActiveSession, parseSessionCookie } from "./sessions.ts";
import { type OAuthDeps, isSameOriginRequest, jsonResponse, resolveBoundOrigins } from "./oauth-shared.ts";

interface RegisterRequestBody {
  redirect_uris?: string[];
  scope?: string;
  client_name?: string;
  token_endpoint_auth_method?: string;
}

export async function handleRegister(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  let body: RegisterRequestBody;
  try {
    body = (await req.json()) as RegisterRequestBody;
  } catch {
    return jsonResponse({ error: "invalid_client_metadata", error_description: "body must be JSON" }, 400);
  }
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
  if (redirectUris.length === 0) {
    return jsonResponse(
      { error: "invalid_redirect_uri", error_description: "redirect_uris is required and must be non-empty" },
      400,
    );
  }
  for (const uri of redirectUris) {
    if (typeof uri !== "string" || !isValidRedirectUri(uri)) {
      return jsonResponse(
        { error: "invalid_redirect_uri", error_description: `invalid redirect_uri "${uri}"` },
        400,
      );
    }
  }

  let status: ClientStatus = "pending";
  let sameHub = false;
  const sessionId = parseSessionCookie(req.headers.get("cookie"));
  const session = sessionId ? await findActiveSession(db, sessionId, deps.now?.() ?? new Date()) : null;
  if (session && isSameOriginRequest(req, resolveBoundOrigins(deps))) {
    status = "approved";
    sameHub = true;
  }

  const confidential = body.token_endpoint_auth_method === "client_secret_post";
  const scopes = (body.scope ?? "").split(" ").filter((s) => s.length > 0);
  let registered: RegisteredClient;
  try {
    registered = await registerClient(db, {
      redirectUris,
      scopes,
      clientName: body.client_name,
      confidential,
      status,
      sameHub,
      now: deps.now,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonResponse({ error: "invalid_client_metadata", error_description: msg }, 400);
  }

  const respBody: Record<string, unknown> = {
    client_id: registered.client.clientId,
    redirect_uris: registered.client.redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: confidential ? "client_secret_post" : "none",
    client_id_issued_at: Math.floor(new Date(registered.client.registeredAt).getTime() / 1000),
    status: registered.client.status,
    same_hub: registered.client.sameHub,
  };
  if (registered.client.scopes.length > 0) respBody.scope = registered.client.scopes.join(" ");
  if (registered.client.clientName) respBody.client_name = registered.client.clientName;
  if (registered.clientSecret) respBody.client_secret = registered.clientSecret;
  return jsonResponse(respBody, 201);
}
