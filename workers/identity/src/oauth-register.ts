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
import {
  type ClientStatus,
  type RegisteredClient,
  isValidRedirectUri,
  redirectsAreFirstParty,
  registerClient,
} from "./clients.ts";
import { findActiveSession, parseSessionCookie } from "./sessions.ts";
import { type OAuthDeps, isSameOriginRequest, jsonResponse, resolveBoundOrigins } from "./oauth-shared.ts";

/**
 * Characters that change how a name SHOWS without being visible letters:
 * controls, format characters (bidi overrides and isolates, zero-width
 * joiners/spaces, BOM), line/paragraph separators and the Hangul fillers that
 * render blank.
 */
const UNSAFE_NAME_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u115f\u1160\u3164\uffa0]/u;

/** Longest `client_name` accepted (it is shown on the Allow screen and in Connections). */
export const MAX_CLIENT_NAME_LENGTH = 100;

/**
 * Exact names of Parachute software that people run THEMSELVES and that
 * registers from its own origin, so it can't pass the first-party test:
 *   - "Parachute Hub (agent connector)": a self-hosted hub connecting an agent
 *     to a cloud vault (parachute-core packages/hub/src/oauth-client.ts),
 *     redirect `<hub origin>/oauth/agent-grant/callback`;
 *   - "Parachute Notes": the Notes app mounted on a self-hosted hub adding a
 *     cloud vault (parachute-app src/lib/vault/discovery.ts), redirect
 *     `<hub origin>/…/oauth/callback`.
 * Exact match only, so a look-alike ("Parachute Notes (official)") is still
 * refused. These still show as unverified, with their origin, on the Allow
 * screen: that line, not the name, is what a person checks.
 */
const SELF_HOSTED_PARACHUTE_NAMES = new Set(["Parachute Hub (agent connector)", "Parachute Notes"]);

/**
 * Common look-alikes of the letters in "parachute" (Cyrillic, Greek, a few
 * Latin extensions) folded to ASCII. Not the full Unicode confusables table
 * (UTS #39); enough that a one-letter swap doesn't slip through.
 */
const LOOKALIKES: Record<string, string> = {
  // Cyrillic
  "\u0420": "p", "\u0440": "p", "\u0410": "a", "\u0430": "a", "\u0433": "r", "\u0421": "c", "\u0441": "c",
  "\u041d": "h", "\u04bb": "h", "\u04ba": "h", "\u0422": "t", "\u0442": "t", "\u0415": "e", "\u0435": "e",
  "\u0454": "e", "\u0404": "e",
  // Greek (lunate sigma ϲ/Ϲ is mapped before NFKD turns it into ς/Σ)
  "\u03f2": "c", "\u03f9": "c", "\u03a1": "p", "\u03c1": "p", "\u0391": "a", "\u03b1": "a", "\u03c2": "c", "\u0397": "h", "\u03c5": "u",
  "\u03a4": "t", "\u03c4": "t", "\u0395": "e", "\u03b5": "e",
  // Latin and Armenian extras
  "\u0251": "a", "\u0570": "h", "\u057d": "u",
  // T-419 review: more Cyrillic (и), Greek η, Latin ɛ ʈ ʋ, small capitals, Lisu, Canadian syllabics, symbols
  "\u0438": "u", "\u03b7": "h", "\u025b": "e", "\u0288": "t", "\u028b": "u",
  "\u1d00": "a", "\u1d04": "c", "\u1d07": "e", "\u029c": "h", "\u1d18": "p", "\u0280": "r", "\u1d1b": "t", "\u1d1c": "u",
  "\ua4d1": "p", "\u146d": "p", "@": "a", "\u20ac": "e",
};

/**
 * "parachute" with some letters swapped for ones the table doesn't know: at least five of the nine must be the real
 * ASCII letter, the rest any other letter. Catches a look-alike from a script the table lacks. A name with no ASCII
 * letters isn't caught; the consent page's redirect origin and "Unverified" label are the defence there.
 */
function nearParachute(folded: string[]): boolean {
  const target = "parachute";
  for (let i = 0; i + target.length <= folded.length; i++) {
    let real = 0;
    let ok = true;
    for (let j = 0; j < target.length; j++) {
      const c = folded[i + j]!;
      if (c === target[j]) real++;
      else if (/[a-z0-9]/.test(c)) { ok = false; break; }
    }
    if (ok && real >= 5) return true;
  }
  return false;
}

/**
 * Does a self-chosen name read as Parachute? Case-, width-, accent- and
 * punctuation-blind, with common look-alike letters folded: NFKD splits
 * fullwidth/compatibility letters and splits accents off their letters, then
 * every non-letter/digit is dropped — accents included ("P.a.r.a chuté" →
 * "parachute").
 */
export function looksLikeParachute(name: string): boolean {
  // Map look-alikes before NFKD (which rewrites some, e.g. ϲ → ς) and before
  // AND after lowercasing (a capital look-alike, Greek Η, lowercases to a
  // different letter, η, than the one it imitates).
  const fold = (ch: string) => LOOKALIKES[ch] ?? ch;
  const folded = name
    .replace(/./gu, fold)
    .normalize("NFKD")
    .replace(/./gu, fold)
    .toLowerCase()
    .replace(/./gu, fold)
    .replace(/[^\p{L}\p{N}]/gu, "");
  return folded.includes("parachute") || nearParachute(Array.from(folded));
}

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
  // A stranger's wrong-shape body is a 400, never a TypeError 500: this door
  // is anonymous and every 5xx counts toward the operator page (ops.ts).
  const invalid = (what: string) =>
    jsonResponse({ error: "invalid_client_metadata", error_description: what }, 400);
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return invalid("body must be a JSON object");
  }
  for (const field of ["scope", "client_name", "token_endpoint_auth_method"] as const) {
    if (body[field] !== undefined && typeof body[field] !== "string") return invalid(`${field} must be a string`);
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
        // Never stringify a non-string: `{"toString": 1}` throws (a 500).
        { error: "invalid_redirect_uri", error_description: `invalid redirect_uri "${typeof uri === "string" ? uri : typeof uri}"` },
        400,
      );
    }
  }

  let status: ClientStatus = "pending";
  let sameHub = false;
  const boundOrigins = resolveBoundOrigins(deps);
  const sessionId = parseSessionCookie(req.headers.get("cookie"));
  const session = sessionId ? await findActiveSession(db, sessionId, deps.now?.() ?? new Date()) : null;
  if (session && isSameOriginRequest(req, boundOrigins)) {
    status = "approved";
    sameHub = true;
  }

  // Reserve Parachute's name (T-419, audit L3-03 F2): a stranger could register
  // "Parachute Console (official)" and the Allow screen would say so. Only a
  // registration whose every redirect is a Parachute origin may use it. Not the
  // auto-approve above: its session + Origin check is a browser fence, and any
  // account holder can send that Origin header from curl. Clients registered
  // before this rule are not touched.
  const clientName = body.client_name;
  if (clientName !== undefined) {
    if (clientName.length > MAX_CLIENT_NAME_LENGTH) {
      return invalid(`client_name must be at most ${MAX_CLIENT_NAME_LENGTH} characters`);
    }
    // Control, format and direction-override characters can make a name SHOW
    // as something its characters don't spell ("\u202Eetuhcarap" displays as
    // "parachute").
    if (UNSAFE_NAME_CHARS.test(clientName)) {
      return invalid("client_name must not contain control, format or text-direction characters");
    }
    const firstParty = redirectsAreFirstParty(redirectUris, boundOrigins);
    if (!firstParty && looksLikeParachute(clientName) && !SELF_HOSTED_PARACHUTE_NAMES.has(clientName)) {
      return invalid("client_name is reserved: an app registered here can't be named Parachute");
    }
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
