/**
 * Identity-side NIP-98 principal attribution (cloud#278 / hub#937).
 *
 * The vault-side READER already exists (cloud#277: parsePrincipalPubkey →
 * created_via = nostr:<hex>). This suite pins the EMITTER:
 *   1. A NIP-98 principal mints `permissions.principal_pubkey`.
 *   2. Bearer / cookie / OAuth principals NEVER carry the claim.
 *   3. A malformed pubkey is dropped, not shipped.
 *   4. `sub` and `client_id` are untouched — attribution, not an identity swap.
 *
 * The cloud account-MCP door is still Bearer-only (no NIP-98 path in this
 * worker). The hop mint is wired so a future door that sets
 * `authKind: "nostr"` + the verified event pubkey stamps the claim; until
 * then live hop tokens stay byte-identical to before. Cloud identity has no
 * hop-reuse cache, so hub#937's cache-key-includes-pubkey change has no
 * analogue here — each callVaultApi mints a fresh 60s token.
 *
 * Contract: parachute-vault `docs/contracts/nostr-principal-attribution.md`.
 */
import { describe, expect, test } from "vitest";
import { signAccessToken, principalAttributionClaims, NOSTR_PUBKEY_RE } from "../src/tokens.ts";
import { callVaultApi, FIRST_PARTY_CLIENT_ID } from "../src/vault-call.ts";
import { ACCOUNT_TOKEN_CLIENT_ID } from "../src/account-token.ts";
import { db, decodeJwtPayload, deps } from "./helpers.ts";

const PUBKEY_A = "a".repeat(64);
const PUBKEY_B = `e6619493${"b".repeat(56)}`;

describe("NOSTR_PUBKEY_RE — byte-identical to the vault reader", () => {
  test("accepts 64 lowercase hex and rejects the vault reader's fail-soft set", () => {
    expect(NOSTR_PUBKEY_RE.test(PUBKEY_A)).toBe(true);
    expect(NOSTR_PUBKEY_RE.test(PUBKEY_B)).toBe(true);
    expect(NOSTR_PUBKEY_RE.test("A".repeat(64))).toBe(false);
    expect(NOSTR_PUBKEY_RE.test("ab".repeat(20))).toBe(false);
    expect(NOSTR_PUBKEY_RE.test(`${PUBKEY_A}0`)).toBe(false);
    expect(NOSTR_PUBKEY_RE.test("z".repeat(64))).toBe(false);
    expect(NOSTR_PUBKEY_RE.test("npub1qqqqq")).toBe(false);
  });
});

describe("principalAttributionClaims — who gets a pubkey claim", () => {
  test("a NIP-98 principal yields permissions.principal_pubkey", () => {
    expect(principalAttributionClaims({ authKind: "nostr", pubkey: PUBKEY_A })).toEqual({
      permissions: { principal_pubkey: PUBKEY_A },
    });
  });

  test("a Bearer / OAuth / password principal yields NOTHING", () => {
    expect(principalAttributionClaims({ authKind: "bearer" })).toBeNull();
    expect(principalAttributionClaims({ authKind: "oauth", pubkey: PUBKEY_A })).toBeNull();
    expect(principalAttributionClaims({ authKind: "password", pubkey: PUBKEY_A })).toBeNull();
    // Even if a pubkey somehow rode along on a non-nostr principal, authKind
    // is the gate — the claim asserts "this key SIGNED the request".
    expect(principalAttributionClaims({ authKind: "bearer", pubkey: PUBKEY_A })).toBeNull();
  });

  test("a malformed pubkey is dropped, not shipped", () => {
    const bad = [
      undefined,
      "",
      "A".repeat(64),
      "ab".repeat(20),
      "z".repeat(64),
      `${PUBKEY_A}0`,
      "npub1qqqqqq",
    ];
    for (const pubkey of bad) {
      expect(principalAttributionClaims({ authKind: "nostr", pubkey })).toBeNull();
    }
  });
});

describe("signAccessToken — the claim on the wire", () => {
  test("NIP-98 permissions land on the JWT; sub and client_id stay put", async () => {
    const attribution = principalAttributionClaims({ authKind: "nostr", pubkey: PUBKEY_B });
    expect(attribution).not.toBeNull();
    const signed = await signAccessToken(db(), {
      sub: "cloud-user",
      scopes: ["vault:uni:write"],
      audience: "vault.uni",
      clientId: ACCOUNT_TOKEN_CLIENT_ID,
      issuer: deps().issuer,
      vaultScope: ["uni"],
      permissions: attribution!.permissions,
    });
    const payload = decodeJwtPayload(signed.token);
    expect(payload.permissions).toEqual({ principal_pubkey: PUBKEY_B });
    expect(payload.sub).toBe("cloud-user");
    expect(payload.aud).toBe("vault.uni");
    expect(payload.scope).toBe("vault:uni:write");
    expect(payload.client_id).toBe(ACCOUNT_TOKEN_CLIENT_ID);
    expect(payload.vault_scope).toEqual(["uni"]);
  });

  test("omitting permissions leaves the claim absent — cookie/OAuth mint is unchanged", async () => {
    const signed = await signAccessToken(db(), {
      sub: "cloud-user",
      scopes: ["vault:uni:read"],
      audience: "vault.uni",
      clientId: FIRST_PARTY_CLIENT_ID,
      issuer: deps().issuer,
      vaultScope: ["uni"],
    });
    const payload = decodeJwtPayload(signed.token);
    expect(payload.permissions).toBeUndefined();
    expect(payload.sub).toBe("cloud-user");
    expect(payload.client_id).toBe(FIRST_PARTY_CLIENT_ID);
  });
});

describe("callVaultApi hop mint — stamps when asked, silent otherwise", () => {
  test("a NIP-98 permissions object rides the hop token Authorization", async () => {
    let captured: string | null = null;
    const attribution = principalAttributionClaims({ authKind: "nostr", pubkey: PUBKEY_A });
    const res = await callVaultApi(
      db(),
      {
        ...deps(),
        vaultFetch: async (_input, init) => {
          const headers = new Headers(init?.headers);
          captured = headers.get("authorization");
          return Response.json({ ok: true }, { status: 200 });
        },
      },
      {
        userId: "cloud-user",
        vaultName: "uni",
        method: "GET",
        apiPath: "/api/notes",
        verb: "read",
        clientId: ACCOUNT_TOKEN_CLIENT_ID,
        permissions: attribution!.permissions,
      },
    );
    expect(res.status).toBe(200);
    expect(captured).toMatch(/^Bearer /);
    const token = captured!.slice("Bearer ".length);
    const payload = decodeJwtPayload(token);
    expect(payload.permissions).toEqual({ principal_pubkey: PUBKEY_A });
    expect(payload.sub).toBe("cloud-user");
    expect(payload.client_id).toBe(ACCOUNT_TOKEN_CLIENT_ID);
    expect(payload.aud).toBe("vault.uni");
  });

  test("the live Bearer hop (no permissions) still carries no claim", async () => {
    let captured: string | null = null;
    const res = await callVaultApi(
      db(),
      {
        ...deps(),
        vaultFetch: async (_input, init) => {
          const headers = new Headers(init?.headers);
          captured = headers.get("authorization");
          return Response.json({ ok: true }, { status: 200 });
        },
      },
      {
        userId: "cloud-user",
        vaultName: "uni",
        method: "GET",
        apiPath: "/api/notes",
        verb: "read",
        clientId: ACCOUNT_TOKEN_CLIENT_ID,
      },
    );
    expect(res.status).toBe(200);
    const token = captured!.slice("Bearer ".length);
    expect(decodeJwtPayload(token).permissions).toBeUndefined();
  });
});
