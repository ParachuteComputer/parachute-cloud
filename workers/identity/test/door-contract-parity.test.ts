/**
 * Drift detector for the shared door contract (Cloud+Hub shared-core campaign,
 * parachute-cloud#116, Phase B — cloud side). The hosted door's issuer constants
 * + account-scope grammar are duplicated in `@openparachute/door-contract` (the
 * self-host hub binds the same canon in its own parity suite). These assertions
 * bind the cloud identity worker's LIVE runtime values to the shared canon by
 * importing from cloud's OWN modules and asserting equality/agreement — never
 * re-deriving the contract in the test. Any future divergence between the cloud
 * issuer and the shared contract fails here, forcing the change through the
 * shared package (and thus the hub twin).
 *
 * This is the mitigation for the plan's single-biggest-risk: until cloud binds
 * its live values, the canon is trusted for the hub only.
 */
import { describe, expect, test } from "vitest";
import {
  ACCESS_TOKEN_TTL_SECONDS as CANON_ACCESS_TTL,
  ACCOUNT_SELF_ADMIN_SCOPE,
  ACCOUNT_SELF_READ_SCOPE,
  ACCOUNT_VAULTS_UNNARROWED,
  REFRESH_GRACE_MS as CANON_REFRESH_GRACE,
  REFRESH_TOKEN_TTL_MS as CANON_REFRESH_TTL,
  accountScope,
  accountVaultsScope,
  checkAuthorizationServerMetadata,
  checkProtectedResourceMetadata,
  composedAccountGrant,
  composedVaultCreateScope,
  composedVaultScope,
  composedWildcardVaultsScope,
  hasAccountScope as canonHasAccountScope,
  isRequestableAccountScope,
  parseComposedAccountScope,
} from "@openparachute/door-contract";
import { type AccountVerb, hasAccountScope } from "../src/account-auth.ts";
import { buildAccountConnectionGrant } from "../src/account-mcp.ts";
import {
  ADVERTISED_SCOPES,
  authorizationServerMetadata,
  protectedResourceMetadata,
} from "../src/oauth-metadata.ts";
import { isNonRequestableScope } from "../src/oauth-shared.ts";
import { ACCESS_TOKEN_TTL_SECONDS, REFRESH_GRACE_MS, REFRESH_TOKEN_TTL_MS } from "../src/tokens.ts";
import { ISSUER, deps } from "./helpers.ts";

describe("door-contract parity — token constants", () => {
  test("the cloud issuer's TTL/grace equal the shared contract", () => {
    expect(ACCESS_TOKEN_TTL_SECONDS).toBe(CANON_ACCESS_TTL);
    expect(REFRESH_TOKEN_TTL_MS).toBe(CANON_REFRESH_TTL);
    expect(REFRESH_GRACE_MS).toBe(CANON_REFRESH_GRACE);
  });
});

describe("door-contract parity — account scope grammar", () => {
  // Cloud keys account scopes by the PER-USER account id (`account:<id>:*`); the
  // hub pins `<id>` to the `self` sentinel. The canon parameterizes `<id>`, so
  // this is NOT a divergence to force-equal — it is the same grammar at
  // different ids. Bind cloud's LIVE matcher to the canon's by asserting they
  // agree on every vector (never re-derive the grammar here).
  const vectors: Array<{ granted: string[]; id: string; verb: AccountVerb }> = [
    { granted: ["account:u_1:admin"], id: "u_1", verb: "read" },
    { granted: ["account:u_1:admin"], id: "u_1", verb: "admin" },
    { granted: ["account:u_1:read"], id: "u_1", verb: "admin" },
    { granted: ["account:u_1:read"], id: "u_1", verb: "read" },
    { granted: ["account:u_2:admin"], id: "u_1", verb: "read" },
    { granted: ["vault:x:admin"], id: "u_1", verb: "read" },
    { granted: [], id: "u_1", verb: "read" },
    { granted: ["account:self:admin"], id: "self", verb: "read" },
  ];

  test("cloud's hasAccountScope agrees with the canon on every vector", () => {
    for (const v of vectors) {
      expect(hasAccountScope(v.granted, v.id, v.verb)).toBe(
        canonHasAccountScope(v.granted, v.id, v.verb),
      );
    }
  });

  test("the canon's self scopes are the hub-side spelling of cloud's grammar", () => {
    expect(accountScope("self", "admin")).toBe(ACCOUNT_SELF_ADMIN_SCOPE);
    expect(accountScope("self", "read")).toBe(ACCOUNT_SELF_READ_SCOPE);
  });
});

describe("door-contract parity — the account-vaults wall exception (Wave A)", () => {
  // Cloud's LIVE wall (`isNonRequestableScope`) delegates its `account:*` branch
  // to the shared `isRequestableAccountScope`. Bind the two by asserting the
  // account branch is EXACTLY the negation of the canon on every vector — never
  // re-derive the grammar here, so any drift forces the change through the shared
  // package (and the hub twin).
  // Every vector literally starts with the lowercase `account:` prefix — the
  // condition under which cloud's wall enters its account branch and delegates to
  // the canon. (A fully-capitalized `Account:...` never enters the account
  // namespace and is handled by the untouched service-admin rule; it's inert
  // downstream regardless, so it isn't part of THIS parity claim.)
  const accountVectors = [
    ACCOUNT_VAULTS_UNNARROWED, // account:vaults
    accountVaultsScope("u_1"), // account:u_1:vaults
    "account:u_1:vaults:work", // 4-part narrowed
    "account:u_1:admin",
    "account:u_1:read",
    "account:admin",
    "account:read",
    "account:Vaults", // mis-cased verb fails closed
    "account:u_1:Vaults",
  ];

  test("cloud's live wall's account branch is the exact negation of the canon", () => {
    for (const s of accountVectors) {
      expect(isNonRequestableScope(s)).toBe(!isRequestableAccountScope(s));
    }
  });

  test("only the account-vaults connection scopes pass the wall; every other account scope is refused", () => {
    expect(isNonRequestableScope(ACCOUNT_VAULTS_UNNARROWED)).toBe(false);
    expect(isNonRequestableScope(accountVaultsScope("u_1"))).toBe(false);
    expect(isNonRequestableScope("account:u_1:vaults:work")).toBe(true);
    expect(isNonRequestableScope("account:u_1:admin")).toBe(true);
    expect(isNonRequestableScope("account:u_1:read")).toBe(true);
  });

  test("the non-account rules are untouched by the exception (service-admin + vault)", () => {
    expect(isNonRequestableScope("hub:admin")).toBe(true);
    expect(isNonRequestableScope("vault:x:admin")).toBe(false);
    expect(isNonRequestableScope("vault:read")).toBe(false);
  });
});

describe("door-contract parity — the composed account-scope grammar (MCP Phase 2)", () => {
  const ID = "u_1";

  test("the vendored contract exports the composed grammar cloud enforces on", () => {
    // Bind cloud's dependency on the composed API: these are the EXACT symbols
    // denyForeignAccountMint (oauth-token.ts), the grants family-replace
    // (grants.ts), and buildAccountConnectionGrant (account-mcp.ts) import from
    // the vendored contract. A materialized contract missing any fails here.
    expect(typeof parseComposedAccountScope).toBe("function");
    expect(typeof composedAccountGrant).toBe("function");
    expect(typeof composedWildcardVaultsScope).toBe("function");
    expect(typeof composedVaultScope).toBe("function");
    expect(typeof composedVaultCreateScope).toBe("function");
  });

  test("the composed builders round-trip through the canon's parser", () => {
    expect(parseComposedAccountScope(composedWildcardVaultsScope(ID, "read"))).toEqual({
      kind: "wildcard-vaults",
      id: ID,
      verb: "read",
    });
    expect(parseComposedAccountScope(composedVaultScope(ID, "work", "write"))).toEqual({
      kind: "vault",
      id: ID,
      vault: "work",
      verb: "write",
    });
    expect(parseComposedAccountScope(composedVaultCreateScope(ID))).toEqual({ kind: "vault-create", id: ID });
  });

  test("cloud's live connection-grant builder agrees with the canon's composed coverage", () => {
    // buildAccountConnectionGrant delegates to the canon's composedAccountGrant +
    // accountVaultsGrant — bind the LIVE builder to the canon on a composed set.
    const scopes = [
      composedWildcardVaultsScope(ID, "read"),
      composedVaultScope(ID, "work", "write"),
      composedVaultCreateScope(ID),
    ];
    const canon = composedAccountGrant(scopes, ID);
    const live = buildAccountConnectionGrant(scopes, ID);
    expect(live).not.toBeNull();
    expect(live!.wildcard).toBe(canon.wildcard);
    expect(live!.create).toBe(canon.create);
    expect([...live!.vaults.entries()].sort()).toEqual([...canon.vaults.entries()].sort());
  });

  test("a composed grant for a FOREIGN id confers nothing (cloud + canon agree)", () => {
    const scopes = [composedWildcardVaultsScope("other", "admin")];
    expect(buildAccountConnectionGrant(scopes, ID)).toBeNull();
    const canon = composedAccountGrant(scopes, ID);
    expect(canon.wildcard).toBeNull();
    expect(canon.vaults.size).toBe(0);
  });
});

describe("door-contract parity — discovery vectors", () => {
  test("cloud's authorization-server metadata conforms to the canon", async () => {
    const md = (await authorizationServerMetadata(deps()).json()) as Record<string, unknown>;
    expect(checkAuthorizationServerMetadata(md, ISSUER, ADVERTISED_SCOPES)).toEqual([]);
  });

  test("cloud's protected-resource metadata conforms to the canon", async () => {
    const md = (await protectedResourceMetadata(deps()).json()) as Record<string, unknown>;
    expect(checkProtectedResourceMetadata(md, ISSUER)).toEqual([]);
  });
});
