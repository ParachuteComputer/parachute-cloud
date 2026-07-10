/**
 * The account-token validator (C1, [PLAN-DECISION SCOPE-c] — the load-bearing
 * one). The `/account/*` REST surface (C3) is Bearer-gated by an
 * `account:<id>:{admin,read}` token minted from the session cookie (C2). This
 * module validates that bearer.
 *
 * DELIBERATE ARCHITECTURE (SCOPE-c): the cloud issuer does NOT import
 * `@openparachute/scope-guard` on the issuer side — the identity worker validates
 * its OWN tokens with its OWN `validateAccessToken` (tokens.ts: kid + iss pin +
 * jti revocation), plus the tiny local `admin ⊇ read` account-scope checker
 * below (a mirror of the vault RS's hand-rolled `hasScopeForVault`, auth.ts:105).
 * The account grammar is trivial (`admin ⊇ read`, a single `<id>` match); the X1
 * twin conformance suite is the parity guard against the hub's scope-guard
 * semantics, not a shared import.
 *
 * The audience is pinned to `"account"` ([PLAN-DECISION SCOPE-a]) so a
 * vault-audience token (`aud=vault.<name>`) can never satisfy an `/account/*`
 * gate, and an account token can never satisfy a vault RS (which strict-checks
 * `aud=vault.<name>`) — belt-and-suspenders in both directions.
 */
import type { JWTPayload } from "jose";
import { validateAccessToken } from "./tokens.ts";

/**
 * The audience an account token carries ([PLAN-DECISION SCOPE-a]). C2 mints with
 * this explicit value (rather than relying on `inferAudience`'s fallback); the
 * validator pins it here. Kept as a named constant so the mint (C2) and the X1
 * conformance suite import the same string rather than re-literaling it.
 */
export const ACCOUNT_TOKEN_AUDIENCE = "account";

export type AccountVerb = "read" | "admin";

/** `admin ⊇ read` — the two-rung account ladder (mirrors auth.ts VERB_RANK). */
const ACCOUNT_VERB_RANK: Record<AccountVerb, number> = { read: 0, admin: 1 };

function isAccountVerb(s: string): s is AccountVerb {
  return s === "read" || s === "admin";
}

/**
 * Decompose an `account:<id>:<verb>` scope. Returns null for anything else
 * (a 2-part `account:admin`, a vault scope, a malformed string) — only the
 * 3-part account grammar carries account authority.
 */
function decomposeAccountScope(scope: string): { id: string; verb: AccountVerb } | null {
  const parts = scope.split(":");
  if (parts.length === 3 && parts[0] === "account" && parts[1]!.length > 0 && isAccountVerb(parts[2]!)) {
    return { id: parts[1]!, verb: parts[2]! };
  }
  return null;
}

/**
 * Does `granted` carry `verb`-or-higher authority over account `<id>`? The local
 * account-scope checker (SCOPE-c) — the mirror of the vault RS's
 * `hasScopeForVault`. `admin` satisfies a `read` requirement; a scope for a
 * different `<id>` never matches.
 */
export function hasAccountScope(granted: readonly string[], accountId: string, verb: AccountVerb): boolean {
  const reqRank = ACCOUNT_VERB_RANK[verb];
  for (const s of granted) {
    const d = decomposeAccountScope(s);
    if (!d) continue;
    if (d.id !== accountId) continue;
    if (ACCOUNT_VERB_RANK[d.verb] >= reqRank) return true;
  }
  return false;
}

/** The distinct account ids named by the `account:<id>:*` scopes in the set. */
function accountIdsIn(scopes: readonly string[]): string[] {
  const ids = new Set<string>();
  for (const s of scopes) {
    const d = decomposeAccountScope(s);
    if (d) ids.add(d.id);
  }
  return [...ids];
}

export interface ValidatedAccountToken {
  /** The account id the token's `account:<id>:*` scopes are keyed on. */
  accountId: string;
  /** The `account:<id>:{admin,read}` scopes the token carries. */
  scopes: string[];
  /** The verified JWT claims (`sub`, `jti`, `exp`, `aud`, …). */
  payload: JWTPayload;
}

export type AccountTokenResult =
  | { ok: true; token: ValidatedAccountToken }
  | { ok: false; status: 401 | 403; error: string; message: string };

/** Strict audience pin — exactly `"account"`, never a multi-aud token. */
function audiencePinned(aud: JWTPayload["aud"], expected: string): boolean {
  if (typeof aud === "string") return aud === expected;
  if (Array.isArray(aud)) return aud.length === 1 && aud[0] === expected;
  return false;
}

/**
 * Validate an account bearer: verify the JWT against the issuer's keys (kid +
 * `iss` pin + jti revocation, via {@link validateAccessToken}), pin
 * `aud="account"`, and derive the single account principal the token speaks for.
 *
 * Does NOT enforce a required verb — the caller runs the per-endpoint gate with
 * {@link hasAccountScope} on the returned `{ accountId, scopes }` (a `GET`
 * needs `read`, a mutation needs `admin`). Returns a typed failure the router
 * maps onto a 401 (authentication) or 403 (an authenticated token that carries
 * no account authority) response.
 */
export async function validateAccountToken(
  db: D1Database,
  token: string,
  opts: { issuer: string },
): Promise<AccountTokenResult> {
  let payload: JWTPayload;
  try {
    // iss-pinned + kid-verified + jti-revocation-checked by the issuer's own
    // validator — NOT scope-guard (SCOPE-c).
    ({ payload } = await validateAccessToken(db, token, opts.issuer));
  } catch (err) {
    return {
      ok: false,
      status: 401,
      error: "invalid_token",
      message: err instanceof Error ? err.message : "token validation failed",
    };
  }

  // SCOPE-a: an account gate accepts ONLY an `aud="account"` token. A
  // vault-audience token (or a multi-aud token) is refused here.
  if (!audiencePinned(payload.aud, ACCOUNT_TOKEN_AUDIENCE)) {
    return {
      ok: false,
      status: 401,
      error: "invalid_token",
      message: `token audience is not '${ACCOUNT_TOKEN_AUDIENCE}'`,
    };
  }

  const scope = typeof payload.scope === "string" ? payload.scope : "";
  const scopes = scope.split(" ").filter((s) => s.length > 0);
  const accountScopes = scopes.filter((s) => decomposeAccountScope(s) !== null);
  const ids = accountIdsIn(accountScopes);

  // A validly-signed `aud=account` token with no account scope carries no
  // account authority (403). More than one distinct `<id>` is malformed — an
  // account token speaks for exactly one owner (401).
  if (ids.length === 0) {
    return { ok: false, status: 403, error: "insufficient_scope", message: "token carries no account scope" };
  }
  if (ids.length > 1) {
    return { ok: false, status: 401, error: "invalid_token", message: "token names more than one account" };
  }

  return { ok: true, token: { accountId: ids[0]!, scopes: accountScopes, payload } };
}
