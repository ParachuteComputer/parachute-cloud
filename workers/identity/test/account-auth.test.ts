/**
 * C1 — the account-scope grammar + validator (SCOPE-a/SCOPE-c). Twin of the hub
 * H1 account-scope work; the X1 conformance suite pins their `admin ⊇ read` +
 * `aud=account` parity. Here we assert, on the cloud side:
 *   - `account:<id>:{admin,read}` is non-requestable via `/oauth/authorize`
 *     (cookie-minted only — refused up front, unlike a named `vault:<name>:*`);
 *   - the local `admin ⊇ read` account-scope checker;
 *   - an account scope never lands in a vault token (`narrowResourceVaultScopes`);
 *   - `validateAccountToken` pins `aud="account"` and derives the principal.
 *
 * Account tokens are non-requestable, so they can't be minted through the OAuth
 * endpoint — the tests mint them directly with `signAccessToken` (the seam C2
 * will wrap behind `POST /account/token`).
 */
import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { handleAuthorizeGet } from "../src/oauth-authorize.ts";
import { inferAudience, narrowResourceVaultScopes } from "../src/audience.ts";
import { findNonRequestableScopes, isNonRequestableScope } from "../src/oauth-shared.ts";
import { signAccessToken } from "../src/tokens.ts";
import {
  ACCOUNT_TOKEN_AUDIENCE,
  hasAccountScope,
  validateAccountToken,
} from "../src/account-auth.ts";
import {
  ISSUER,
  REDIRECT_URI,
  authorizeGetReq,
  db,
  deps,
  makePkce,
  seedApprovedClient,
} from "./helpers.ts";

const ACCOUNT_ID = "user-c1";
const ADMIN = `account:${ACCOUNT_ID}:admin`;
const READ = `account:${ACCOUNT_ID}:read`;

/** Mint an account bearer directly (the seam C2 wraps) — issuer-signed. */
async function mintAccountToken(
  opts: { scopes?: string[]; audience?: string; sub?: string } = {},
): Promise<string> {
  const { token } = await signAccessToken(db(), {
    sub: opts.sub ?? ACCOUNT_ID,
    scopes: opts.scopes ?? [ADMIN],
    audience: opts.audience ?? ACCOUNT_TOKEN_AUDIENCE,
    clientId: "parachute-console",
    issuer: ISSUER,
    vaultScope: [],
    ttlSeconds: 600,
  });
  return token;
}

// --- the grammar: non-requestable via /oauth/authorize ---------------------

describe("account scope grammar — non-requestable at /oauth/authorize", () => {
  test("both account verbs are non-requestable; a named vault scope stays requestable", () => {
    expect(isNonRequestableScope(ADMIN)).toBe(true);
    expect(isNonRequestableScope(READ)).toBe(true);
    // The 2-part account:admin (were it ever formed) is refused too.
    expect(isNonRequestableScope("account:admin")).toBe(true);
    // Regression: the pre-existing service-admin + vault rules are unchanged.
    expect(isNonRequestableScope("hub:admin")).toBe(true);
    expect(isNonRequestableScope("vault:field-notes:admin")).toBe(false);
    expect(isNonRequestableScope("vault:read")).toBe(false);
  });

  test("findNonRequestableScopes flags account scopes out of a mixed set", () => {
    expect(findNonRequestableScopes(["vault:field-notes:read", ADMIN, READ])).toEqual([ADMIN, READ]);
  });

  test("GET /oauth/authorize refuses an account scope with invalid_scope (no consent)", async () => {
    const { clientId } = await seedApprovedClient({ clientName: "Some App" });
    const { challenge } = await makePkce();
    const res = await handleAuthorizeGet(
      db(),
      authorizeGetReq({
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        scope: ADMIN,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "st-c1",
      }),
      deps(),
    );
    // Protocol error → redirect back to the client with error=invalid_scope.
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe(REDIRECT_URI);
    expect(loc.searchParams.get("error")).toBe("invalid_scope");
    expect(loc.searchParams.get("state")).toBe("st-c1");
    // The account scope name appears in the human description.
    expect(loc.searchParams.get("error_description")).toContain(ADMIN);
  });
});

// --- the local admin ⊇ read checker (SCOPE-c) ------------------------------

describe("hasAccountScope — admin ⊇ read, id-pinned", () => {
  test("admin satisfies both admin and read", () => {
    expect(hasAccountScope([ADMIN], ACCOUNT_ID, "admin")).toBe(true);
    expect(hasAccountScope([ADMIN], ACCOUNT_ID, "read")).toBe(true);
  });

  test("read satisfies read but NOT admin", () => {
    expect(hasAccountScope([READ], ACCOUNT_ID, "read")).toBe(true);
    expect(hasAccountScope([READ], ACCOUNT_ID, "admin")).toBe(false);
  });

  test("a scope for a different account id never matches", () => {
    expect(hasAccountScope(["account:other:admin"], ACCOUNT_ID, "read")).toBe(false);
  });

  test("non-account and malformed scopes grant nothing", () => {
    expect(hasAccountScope(["vault:field-notes:admin", "account:admin"], ACCOUNT_ID, "read")).toBe(false);
  });
});

// --- account scope never lands in a vault token (SCOPE-a, risk #1) ----------

describe("audience derivation — account scopes and vault tokens", () => {
  test("narrowResourceVaultScopes DROPS account scopes when binding a vault token", () => {
    const out = narrowResourceVaultScopes([ADMIN, "vault:read", READ], "field-notes");
    // Only the (narrowed) vault scope survives; both account scopes are gone.
    expect(out).toEqual(["vault:field-notes:read"]);
    expect(out.some((s) => s.startsWith("account:"))).toBe(false);
  });

  test("a lone account scope infers aud='account' (SCOPE-a grammar coherence)", () => {
    expect(inferAudience([ADMIN])).toBe(ACCOUNT_TOKEN_AUDIENCE);
  });
});

// --- the validator: aud pinned, principal derived --------------------------

describe("validateAccountToken — aud=account pinned + principal derivation", () => {
  test("accepts a well-formed account token; returns accountId + scopes", async () => {
    const token = await mintAccountToken({ scopes: [ADMIN] });
    const res = await validateAccountToken(db(), token, { issuer: ISSUER });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.token.accountId).toBe(ACCOUNT_ID);
    expect(res.token.scopes).toEqual([ADMIN]);
    expect(res.token.payload.aud).toBe(ACCOUNT_TOKEN_AUDIENCE);
    // The endpoint gate then runs on the returned principal.
    expect(hasAccountScope(res.token.scopes, res.token.accountId, "admin")).toBe(true);
  });

  test("rejects a vault-audience token carrying an account scope (SCOPE-a, 401)", async () => {
    const token = await mintAccountToken({ scopes: [ADMIN], audience: "vault.field-notes" });
    const res = await validateAccountToken(db(), token, { issuer: ISSUER });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(401);
    expect(res.error).toBe("invalid_token");
    expect(res.message).toContain(ACCOUNT_TOKEN_AUDIENCE);
  });

  test("rejects a token from a foreign issuer (iss pin, 401)", async () => {
    const token = await mintAccountToken({ scopes: [ADMIN] });
    const res = await validateAccountToken(db(), token, { issuer: "https://evil.example" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(401);
    expect(res.error).toBe("invalid_token");
  });

  test("an aud=account token with no account scope has no authority (403)", async () => {
    const token = await mintAccountToken({ scopes: ["vault:field-notes:read"] });
    const res = await validateAccountToken(db(), token, { issuer: ISSUER });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(403);
    expect(res.error).toBe("insufficient_scope");
  });

  test("a garbage bearer is refused (401)", async () => {
    const res = await validateAccountToken(db(), "not-a-jwt", { issuer: ISSUER });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(401);
  });

  test("a read-only account token validates but fails an admin gate (end-to-end)", async () => {
    const token = await mintAccountToken({ scopes: [READ] });
    const res = await validateAccountToken(db(), token, { issuer: ISSUER });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(hasAccountScope(res.token.scopes, res.token.accountId, "read")).toBe(true);
    expect(hasAccountScope(res.token.scopes, res.token.accountId, "admin")).toBe(false);
  });
});
