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
  REFRESH_GRACE_MS as CANON_REFRESH_GRACE,
  REFRESH_TOKEN_TTL_MS as CANON_REFRESH_TTL,
  accountScope,
  checkAuthorizationServerMetadata,
  checkProtectedResourceMetadata,
  hasAccountScope as canonHasAccountScope,
} from "@openparachute/door-contract";
import { type AccountVerb, hasAccountScope } from "../src/account-auth.ts";
import {
  ADVERTISED_SCOPES,
  authorizationServerMetadata,
  protectedResourceMetadata,
} from "../src/oauth-metadata.ts";
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
