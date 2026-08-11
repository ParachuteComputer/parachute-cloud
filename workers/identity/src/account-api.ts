/**
 * The `/account/*` vault-lifecycle REST surface (C3, Parachute App campaign
 * #116) — the HOSTED door's twin of the self-host hub's H2. Bearer-gated by the
 * account credential C2 mints (`POST /account/token`) and C1 validates
 * (account-auth.ts): every route pulls an `Authorization: Bearer <account
 * token>`, runs it through {@link validateAccountToken}, and gates on
 * {@link hasAccountScope} — `read` for the GETs, `admin` for the mutations. The
 * account id is taken from the TOKEN, never a request body: user A's token can
 * only ever list, create under, mint for, or delete user A's vaults. Tenant
 * safety is THE property this surface must hold.
 *
 * WRAP, DON'T REIMPLEMENT. These handlers drive the SAME machinery the
 * cookie-authed console already runs, only the outer auth boundary differs
 * (Bearer account token here vs session cookie + CSRF + same-origin there):
 *   - create → `createVault` + the plan vault-count cap (PLAN_SPECS /
 *     countVaultsForOwner, IDENTICAL to handleCreateVaultPost) + `pushVaultCap`;
 *   - list   → `listVaultsForOwner` + the daily rollup's `vault_usage` rows;
 *   - mint   → the `vault-call.ts` first-party mint seam's `signAccessToken`,
 *     ownership-gated (`userOwnsVault`), scope-validated to this one vault.
 *   - delete → the same first-party seam's destroy call, followed by the
 *     explicit identity-side D1 sweep (the vault worker is always first).
 *
 * THE TENANT-FACING VAULT TOKEN'S client_id — a deliberate divergence from the
 * plan's literal `client_id="parachute-console"`, and it is security-load-
 * bearing. The vault tokens this surface mints carry `client_id="parachute-
 * account"` ({@link ACCOUNT_TOKEN_CLIENT_ID}), NOT the `"parachute-console"`
 * FIRST_PARTY_CLIENT_ID the vault worker's internal cap/snapshot/restore seam is
 * gated on (workers/vault/src/vault-do.ts `internalForbidden`). Stamping the
 * first-party id on a token handed to the browser — an ADMIN-scoped one from the
 * per-vault mint especially — would let a tenant drive the PLATFORM's internal
 * controls (push arbitrary caps, restore, snapshot). The distinct id keeps these
 * tokens exactly as powerful as a vault token the owner can already mint through
 * public OAuth, and no more; the internal seam stays first-party-only.
 *
 * The audience is pinned to `vault.<name>` and `vault_scope` to the one vault,
 * so a token minted for vault A can never be spent against vault B or the
 * account surface — belt-and-suspenders with the account-token's `aud="account"`
 * pin (account-auth.ts).
 */
import { validateVaultScopes } from "@openparachute/door-contract";
import { ACCOUNT_TOKEN_CLIENT_ID } from "./account-token.ts";
import {
  type AccountVerb,
  hasAccountScope,
  validateAccountToken,
} from "./account-auth.ts";
import {
  type OAuthDeps,
  buildServicesCatalog,
  jsonResponse,
  vaultAdvertisedUrl,
} from "./oauth-shared.ts";
import {
  PLAN_SPECS,
  TIER_PRICE_MONTHLY_USD,
  entitlementPlanFor,
  isPaidTier,
  planEntitlement,
  planTotalBytes,
  vaultCapMessage,
} from "./plans.ts";
import { ACCESS_TOKEN_TTL_SECONDS, signAccessToken } from "./tokens.ts";
import {
  HandleAlreadySetError,
  HandleInvalidError,
  HandleTakenError,
  claimHandle,
  getOwnerHandle,
  handleIsAvailable,
  suggestHandleFromEmail,
  validateHandle,
} from "./handles.ts";
import { type User, getUserById } from "./users.ts";
import { callVaultDestroy, pushVaultCap } from "./vault-call.ts";
import {
  VaultNameInvalidError,
  VaultNameTakenError,
  countVaultsForOwner,
  createVault,
  deleteVaultD1Rows,
  listVaultsForOwner,
  userOwnsVault,
} from "./vaults.ts";
import { latestUsageForVaults } from "./usage.ts";

/** TTL for the tenant-facing vault tokens this surface mints — the standard
 *  access-token lifetime. Stateless (no registry row, no refresh, like the
 *  vault-call.ts mints); the SDK re-mints via `POST /account/vaults/<name>/token`
 *  when it lapses. */
export const ACCOUNT_VAULT_TOKEN_TTL_SECONDS = ACCESS_TOKEN_TTL_SECONDS;

/**
 * OAuth-style auth-failure body (`{ error, error_description }`), matching
 * account-token.ts — used for the token/scope gates (401/403).
 */
function authError(status: number, error: string, description: string): Response {
  return jsonResponse({ error, error_description: description }, status, { "cache-control": "no-store" });
}

/**
 * REST/business-error body (`{ error, message }`), matching the vault-call
 * response shape — used for resource-level failures (invalid name, taken,
 * at-cap, not-owned, and teardown failures).
 */
function restError(status: number, error: string, message: string): Response {
  return jsonResponse({ error, message }, status, { "cache-control": "no-store" });
}

/** Pull the `Bearer <token>` value from the Authorization header, or null. */
function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1]!.trim() : null;
}

/** Parse a JSON request body into an object, tolerant of an absent/malformed
 *  body. Exported for the sibling account-API billing doors (billing.ts). */
export async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = (await req.json()) as unknown;
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * The Bearer gate every `/account/*` route runs first, in order:
 *   1. extract + validate the token (C1 — kid + iss + jti-revocation +
 *      `aud="account"` pin) → 401 on missing/invalid;
 *   2. resolve the account owner, and REFUSE A DELETED OR SUSPENDED OWNER —
 *      the read-time refusal chokepoint. C1's validator is stateless by
 *      design (SCOPE-d), so both are enforced HERE: the account bearer is the
 *      account-admin equivalent of a session, and the session path already
 *      refuses deleted/suspended owners read-time (findActiveSession).
 *      Applying the same chokepoint to the bearer means a moderation suspend
 *      (or a self-serve delete, migration 0023) severs the account surface
 *      immediately, not after the token's short TTL lapses. A deleted owner
 *      gets the SAME 401 `invalid_token` body as a missing row (no oracle,
 *      not even the distinguishable `account_suspended` a suspended owner
 *      gets); (this is stricter than the "OAuth tokens expire naturally" note
 *      on migration 0011, deliberately so — that note governs VAULT tokens
 *      spent at the vault RS, which has no user table to consult; the
 *      account surface runs at the issuer, which can and does check.)
 *   3. require `verb`-or-higher account authority → 403 on an underscoped token.
 *
 * Returns the account id AND the loaded owner (so callers needing the plan don't
 * re-read) on success, or a typed error Response. The account id is the ONLY
 * tenant key downstream — never a body/path field.
 *
 * Exported so sibling `/account/*` surfaces outside this file — the Bearer-
 * gated billing endpoints (billing.ts `handleAccountBillingPortalPost` /
 * `handleAccountBillingCheckoutPost`) — share the SAME auth gate rather than
 * re-deriving it. Every `/account/*` route must resolve auth through this one
 * function so the tenant-scoping property (bearer `sub` = the only account a
 * caller can act on) holds in exactly one place.
 */
export async function requireAccount(
  db: D1Database,
  req: Request,
  deps: OAuthDeps,
  verb: AccountVerb,
): Promise<{ ok: true; accountId: string; user: User } | { ok: false; response: Response }> {
  const token = bearerToken(req);
  if (!token) {
    return { ok: false, response: authError(401, "invalid_token", "missing bearer token") };
  }
  const result = await validateAccountToken(db, token, { issuer: deps.issuer });
  if (!result.ok) {
    return { ok: false, response: authError(result.status, result.error, result.message) };
  }
  const accountId = result.token.accountId;
  const user = await getUserById(db, accountId);
  // A DELETED account (migration 0023) gets the exact SAME response as a
  // missing row — no oracle, and deliberately NOT the distinguishable
  // `account_suspended` a live-but-suspended owner gets below: deletion is a
  // stronger, one-way fact than suspension, so it degrades all the way to
  // "doesn't exist" rather than to a named refusal.
  if (!user || user.deletedAt !== null) {
    return { ok: false, response: authError(401, "invalid_token", "account not found") };
  }
  if (user.suspendedAt !== null) {
    return { ok: false, response: authError(401, "account_suspended", "this account is suspended") };
  }
  if (!hasAccountScope(result.token.scopes, accountId, verb)) {
    return {
      ok: false,
      response: authError(403, "insufficient_scope", `account:${accountId}:${verb} required`),
    };
  }
  return { ok: true, accountId, user };
}

/** The vault name segment from `/account/vaults/<name>[/token]`, lowercased, or
 *  null if the path doesn't match (defensive — the router guarantees a match). */
function vaultNameFromPath(req: Request, suffix: "" | "/token"): string | null {
  const path = new URL(req.url).pathname;
  const m = new RegExp(`^/account/vaults/([^/]+)${suffix}/?$`).exec(path);
  return m ? decodeURIComponent(m[1]!).toLowerCase() : null;
}

// --- GET /account/vaults — list the account's vaults -------------------------

/**
 * List every vault the account owns, with its URL, creation time, and latest
 * recorded storage split (the daily rollup's `vault_usage` row — absent when no
 * row exists yet, e.g. a vault created since the last rollup). One batched usage
 * query, so the list stays cheap. Scope: `account:<id>:read`.
 */
export async function handleAccountVaultsList(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const auth = await requireAccount(db, req, deps, "read");
  if (!auth.ok) return auth.response;

  const vaults = await listVaultsForOwner(db, auth.accountId);
  const usage = await latestUsageForVaults(
    db,
    vaults.map((v) => v.name),
  );
  const list = vaults.map((v) => {
    const row = usage.get(v.name);
    return {
      name: v.name,
      // The immutable identity behind `name` (migration 0020, handles/sharing
      // groundwork) — additive; `name` stays the wire identifier everywhere
      // else (scopes, URLs, DO addressing) for now. Null only for a legacy row
      // predating the migration's backfill (shouldn't happen once applied).
      vault_id: v.vaultId,
      url: vaultAdvertisedUrl(v.name, deps),
      created_at: v.createdAt,
      // dbBytes → notes graph, r2Bytes → attachment binaries (the two-meter
      // split the plan caps push mirrors). Null until the first rollup lands.
      usage: row ? { notes_bytes: row.dbBytes, attachment_bytes: row.r2Bytes } : null,
    };
  });
  return jsonResponse({ vaults: list }, 200, { "cache-control": "no-store" });
}

// --- GET /account/summary — the account's plan + usage summary --------------

/**
 * The account-level plan/usage summary the app's Account screen renders — the
 * app-as-manager door. Bearer-gated `account:<id>:read` (the SAME requireAccount
 * gate as GET /account/vaults). Every plan limit/used field is OPTIONAL: we emit
 * only what we honestly meter, and the app renders what's present (never fakes a
 * number). Matches the app's canonical `AccountSummary` type. Scope: read.
 */
export async function handleAccountSummary(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const auth = await requireAccount(db, req, deps, "read");
  if (!auth.ok) return auth.response;
  const { user } = auth;
  const now = deps.now?.() ?? new Date();

  // The tier whose LIMITS apply — a trial mirrors its chosen tier (or Plus),
  // exactly as the vault-cap push resolves it (entitlementPlanFor).
  const effective = entitlementPlanFor(user.plan, user.pendingPlan);
  const spec = PLAN_SPECS[effective];

  // vaults_used + account-wide storage_used — one batched usage query (the list
  // handler's pattern). storage collapses the two-meter split (notes + attach)
  // into the single number the app's summary shows.
  const vaults = await listVaultsForOwner(db, user.id);
  const usage = await latestUsageForVaults(
    db,
    vaults.map((v) => v.name),
  );
  let storageUsed = 0;
  for (const v of vaults) {
    const row = usage.get(v.name);
    if (row) storageUsed += row.dbBytes + row.r2Bytes;
  }

  const plan: {
    tier: string;
    label: string;
    price_monthly_usd?: number;
    vault_limit?: number;
    vaults_used?: number;
    storage_used_bytes?: number;
    storage_limit_bytes?: number;
    trial_days_left?: number;
  } = {
    tier: user.plan,
    label: user.plan === "trial" ? "Free trial" : PLAN_SPECS[user.plan].label,
    vault_limit: spec.vault_count,
    vaults_used: vaults.length,
    storage_used_bytes: storageUsed,
    // The effective tier's total (notes + attachment) budget — the same sum the
    // cap push computes; call the helper rather than re-inlining it.
    storage_limit_bytes: planTotalBytes(effective),
  };
  // A current monthly price only for a paid tier (trial/expired aren't charged).
  // Read the numeric source directly — no regex-strip of the display label.
  if (isPaidTier(user.plan)) {
    plan.price_monthly_usd = TIER_PRICE_MONTHLY_USD[user.plan];
  }
  if (user.plan === "trial" && user.planDowngradeAt) {
    const msLeft = new Date(user.planDowngradeAt).getTime() - now.getTime();
    plan.trial_days_left = Math.max(0, Math.ceil(msLeft / (24 * 60 * 60 * 1000)));
  }

  // The account's claimed handle (migration 0022, the GitHub owner-model) or
  // null — additive, so the app can render "@handle" beside the email and its
  // claim CTA when null. A single-hop owners lookup (null ownerId → no query).
  const handle = await getOwnerHandle(db, user.ownerId);

  return jsonResponse(
    {
      email: user.email,
      account_created_at: user.createdAt,
      handle,
      plan,
      // Honest capability signal for the app's "Manage plan & billing"
      // section — NOT a URL anymore (billing.ts's Bearer-gated
      // `/account/billing/{portal,checkout}` doors replace the old
      // `manage_billing_url: <issuer>/console` cross-origin hop this field
      // used to carry: the app now calls those directly with the account
      // bearer it already holds and redirects straight to Stripe, no
      // console/re-login round-trip). True when EITHER the real Stripe
      // config is present OR the interim mock path is active (mirrors the
      // console's OWN `checkoutAvailable = billingConfigured ||
      // mockBillingEnabled`, ui.ts) — staging (mock, no real keys) still
      // shows the section so the no-relogin flow is exercisable there;
      // production with neither hides it, matching the console's own
      // teaser-only state.
      billing_enabled: deps.billingConfigured === true || deps.mockBillingEnabled === true,
      // Whether this account has a Stripe customer to MANAGE — lets the app
      // decide the billing CTA up front: show "Manage billing" (→ POST
      // /account/billing/portal) only when true; otherwise "Upgrade" (→ POST
      // /account/billing/checkout). Without this the app would blind-tap the
      // portal for a comped/mock paid account (no Stripe customer) and hit its
      // reactive 409 `no_billing_customer`. Mirrors the console's own
      // `hasBillingAccount` gate on the Manage-billing button (ui.ts).
      has_billing_customer: !!user.stripeCustomerId,
    },
    200,
    { "cache-control": "no-store" },
  );
}

// --- handles (migration 0022, the GitHub owner-model) ------------------------

/**
 * GET /account/handle — the account's claimed handle (or null) plus a friendly
 * email-derived suggestion the app can prefill its claim field with. Scope:
 * `account:<id>:read` (same requireAccount gate as the other GETs). Additive,
 * inert on the wire until later waves serve `/u/<handle>` URLs.
 */
export async function handleAccountHandleGet(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const auth = await requireAccount(db, req, deps, "read");
  if (!auth.ok) return auth.response;
  const handle = await getOwnerHandle(db, auth.user.ownerId);
  return jsonResponse(
    { handle, suggested: suggestHandleFromEmail(auth.user.email) },
    200,
    { "cache-control": "no-store" },
  );
}

/**
 * GET /account/handle/check?handle= — is a candidate handle claimable? Returns
 * `{ available, reason? }`: `reason` is `invalid` (fails the shape rules),
 * `reserved` (a first-party/platform word), or `taken` (already claimed).
 * Availability is public information GitHub-style, but the endpoint STAYS behind
 * the account bearer (`read`) per the plan — a signed-in gate, not an open one.
 * The `handle` is canonicalized (trim + lowercase) before every check, so a
 * caller learns availability for the same handle a claim would actually take.
 */
export async function handleAccountHandleCheck(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const auth = await requireAccount(db, req, deps, "read");
  if (!auth.ok) return auth.response;

  const raw = new URL(req.url).searchParams.get("handle") ?? "";
  const check = validateHandle(raw);
  if (!check.ok) {
    return jsonResponse({ available: false, reason: check.reason }, 200, { "cache-control": "no-store" });
  }
  const available = await handleIsAvailable(db, check.handle);
  return jsonResponse(
    available ? { available: true } : { available: false, reason: "taken" },
    200,
    { "cache-control": "no-store" },
  );
}

/**
 * POST /account/handle — claim a handle (claim-once; rename is Wave E). Scope:
 * `account:<id>:admin` (a write on the account). Body `{ handle }`. Wraps
 * `claimHandle` (handles.ts) — the same core the console door will call — and
 * maps its typed failures onto the wire:
 *   - 400 `invalid_handle` / `reserved` (HandleInvalidError, by reason),
 *   - 409 `handle_taken` (HandleTakenError — claimed concurrently by another),
 *   - 409 `handle_already_set` (HandleAlreadySetError — this account already
 *     holds one; a rename is not yet supported).
 * On success answers `{ handle }` — the canonical (lowercased) handle claimed.
 */
export async function handleAccountHandleClaim(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const auth = await requireAccount(db, req, deps, "admin");
  if (!auth.ok) return auth.response;

  const body = await readJsonBody(req);
  const rawHandle = typeof body.handle === "string" ? body.handle : "";
  try {
    const { handle } = await claimHandle(db, auth.accountId, rawHandle, deps.now?.() ?? new Date());
    return jsonResponse({ handle }, 200, { "cache-control": "no-store" });
  } catch (err) {
    if (err instanceof HandleInvalidError) {
      return err.reason === "reserved"
        ? restError(400, "reserved", "That handle is reserved. Please choose another.")
        : restError(
            400,
            "invalid_handle",
            "Use 3–30 characters: lowercase letters, numbers, and hyphens (not starting or ending with a hyphen).",
          );
    }
    if (err instanceof HandleTakenError) {
      return restError(409, "handle_taken", "That handle is already taken.");
    }
    if (err instanceof HandleAlreadySetError) {
      return restError(409, "handle_already_set", "This account already has a handle.");
    }
    throw err;
  }
}

// --- POST /account/vaults — create (the hinge: lands you IN the vault) -------

/**
 * Create a vault and return a ready-to-use vault token, so the app lands the
 * user straight IN the new vault with zero extra OAuth round-trips (the D2
 * hinge). Wraps the SAME create path the console's `handleCreateVaultPost` runs:
 * the plan vault-count cap (IDENTICAL gate — a Bearer create is refused at-cap
 * exactly as a cookie create is), `createVault` (slug + reserved + PK-collision
 * validation), and the best-effort `pushVaultCap`. Then it additionally mints a
 * `vault:<name>:{read,write}` token (aud-pinned, `client_id="parachute-account"`
 * — see the module note) and returns it. Scope: `account:<id>:admin`.
 *
 * Errors: 400 `invalid_name`/`reserved` (VaultNameInvalidError), 409
 * `vault_taken` (VaultNameTakenError), 403 `vault_limit_reached` (plan cap —
 * the same friendly message the console shows).
 */
export async function handleAccountVaultCreate(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const auth = await requireAccount(db, req, deps, "admin");
  if (!auth.ok) return auth.response;
  const user = auth.user;

  // Plan vault-count gate — IDENTICAL to handleCreateVaultPost (console.ts): the
  // `>=` grandfathers users already over a cap (they keep every vault they own;
  // only NEW creation is refused). An expired plan has vault_count=0, so it is
  // refused here with the same at-cap message the console gives.
  const spec = PLAN_SPECS[user.plan];
  if ((await countVaultsForOwner(db, user.id)) >= spec.vault_count) {
    return restError(403, "vault_limit_reached", vaultCapMessage(user.plan));
  }

  const body = await readJsonBody(req);
  const rawName = typeof body.name === "string" ? body.name : "";
  let name: string;
  let vaultId: string | null;
  try {
    const vault = await createVault(db, rawName, user.id, deps.now?.() ?? new Date());
    name = vault.name;
    vaultId = vault.vaultId;
  } catch (err) {
    if (err instanceof VaultNameInvalidError) {
      return err.reason === "reserved"
        ? restError(400, "reserved", "That name is reserved. Please choose another.")
        : restError(
            400,
            "invalid_name",
            "Use 2–63 characters: lowercase letters, numbers, and hyphens (starting with a letter or number).",
          );
    }
    if (err instanceof VaultNameTakenError) {
      return restError(409, "vault_taken", "That vault name is already taken.");
    }
    throw err;
  }

  // Push the plan's storage cap + voice entitlement into the new vault's DO —
  // best-effort by the same contract as the console (a hiccup leaves the DO on
  // the more-generous env default; applyPlanToVaults / the backfill reconcile).
  await pushVaultCap(db, deps, user.id, name, planEntitlement(entitlementPlanFor(user.plan, user.pendingPlan)));

  const scopes = [`vault:${name}:read`, `vault:${name}:write`];
  const minted = await mintVaultToken(db, deps, user.id, name, scopes);
  return jsonResponse(
    {
      name,
      // The immutable identity behind `name` (migration 0020, handles/sharing
      // groundwork) — additive; see the /account/vaults list handler's note.
      vault_id: vaultId,
      url: vaultAdvertisedUrl(name, deps),
      vault_token: minted.token,
      // NOTE: `url` above is the advertised PUBLIC origin (A3 URL coherence);
      // `services` below stays wire-level (buildServicesCatalog → vaultInstanceUrl
      // / VAULT_ORIGIN) — the app's actual REST/MCP calls resolve through it,
      // and that seam is deliberately untouched by this display-only change.
      services: buildServicesCatalog(scopes, deps),
    },
    201,
    { "cache-control": "no-store" },
  );
}

// --- DELETE /account/vaults/<name> — destroy + identity cleanup ---------------

/**
 * Delete an owned vault through the hosted door. The Bearer account gate and the
 * retype-the-name guard run before the destructive call; ownership is checked
 * against the account id in the bearer, so an unknown vault and another user's
 * vault share the same neutral `not_owner` response.
 *
 * Order is load-bearing: the vault worker is the source of truth for whether
 * tenant data actually disappeared, so its idempotent destroy call happens
 * BEFORE the D1 sweep. A non-2xx or transport failure leaves every identity row
 * intact for a retry. Once destroy succeeds, the D1 batch runs the same cascade
 * the self-hosted hub twin runs — revoke the tokens naming this vault, rewrite
 * the grants that name it, then drop the vault, usage, and snapshot rows; a D1
 * failure is reported separately because the storage side is already erased.
 *
 * Idempotency choice: after the first successful delete, the `vaults` row is
 * gone. A second request therefore returns the same 403 `not_owner` shape as a
 * first request for an unknown or unowned vault. This is intentional: it avoids
 * an existence oracle while ensuring a re-delete never throws or returns 500.
 * Scope: `account:<id>:admin`.
 *
 * NO UNDO WINDOW HERE — deliberately, and not to be confused with its sibling.
 * The 24-hour undo window Aaron ratified belongs to ACCOUNT deletion (`DELETE
 * /account`, the A-train: migration 0023's `users.deleted_at` tombstone, the
 * `billing-teardown.ts` module, and the convergence sweep). That design can
 * defer destruction because an account's teardown is a billing/auth state
 * change first. A VAULT delete cannot: the only verb that erases vault content
 * is the vault worker's `POST /api/internal/destroy` (cloud#226 PR-1), which is
 * irreversible and immediate by construction — `deleteAll()` on the DO plus an
 * R2 prefix purge. Staging a vault delete would need its own reversible
 * substrate (the unmerged PR-2a `vaults.deleting_at` / `destroy_completed_at`
 * columns plus a sweep); until that lands, the retype-the-name confirm IS the
 * guard, exactly as the self-hosted hub twin (`handleDeleteVault`) has it.
 *
 * Convergence if the D1 sweep fails after a successful destroy: the response
 * says so (`500 d1_cleanup_failed`) and the whole request is safe to repeat —
 * destroy is idempotent on a warm instance and re-runs harmlessly on a cold
 * one, and the D1 batch is written to be re-runnable. Until the retry lands,
 * the stale `vaults` row presents as an empty vault, not as tenant data.
 */
export async function handleAccountVaultDelete(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const auth = await requireAccount(db, req, deps, "admin");
  if (!auth.ok) return auth.response;

  const name = vaultNameFromPath(req, "");
  if (!name) return restError(404, "not_found", "no such vault route");

  const body = await readJsonBody(req);
  if (body.confirm !== name) {
    return restError(400, "confirm_mismatch", `deleting a vault requires the body {"confirm": "${name}"}`);
  }

  // Ownership: false for BOTH "owned by someone else" and "doesn't exist" —
  // one 403 for both, so deletion cannot become an existence oracle. This gate
  // is intentionally before the first-party vault-worker call.
  if (!(await userOwnsVault(db, auth.accountId, name))) {
    return restError(403, "not_owner", `You do not own a vault named "${name}".`);
  }

  let destroyResponse: Response;
  try {
    destroyResponse = await callVaultDestroy(db, deps, auth.accountId, name);
  } catch (err) {
    console.error(
      `event=vault_destroy_failed vault=${name} error=${JSON.stringify(err instanceof Error ? err.message : String(err))}`,
    );
    return restError(
      502,
      "vault_destroy_failed",
      "The vault storage teardown could not be reached. No identity rows were changed; retry the request.",
    );
  }
  if (!destroyResponse.ok) {
    console.error(`event=vault_destroy_failed vault=${name} status=${destroyResponse.status}`);
    return restError(
      502,
      "vault_destroy_failed",
      `The vault storage teardown returned HTTP ${destroyResponse.status}. No identity rows were changed; retry the request.`,
    );
  }

  let destroyBody: { destroyed?: unknown; r2_objects_deleted?: unknown };
  try {
    destroyBody = (await destroyResponse.json()) as { destroyed?: unknown; r2_objects_deleted?: unknown };
  } catch {
    return restError(
      502,
      "vault_destroy_failed",
      "The vault storage teardown returned an unreadable response. No identity rows were changed; retry the request.",
    );
  }
  if (
    destroyBody.destroyed !== true ||
    typeof destroyBody.r2_objects_deleted !== "number" ||
    !Number.isSafeInteger(destroyBody.r2_objects_deleted) ||
    destroyBody.r2_objects_deleted < 0
  ) {
    return restError(
      502,
      "vault_destroy_failed",
      "The vault storage teardown returned an invalid success response. No identity rows were changed; retry the request.",
    );
  }

  let d1: Awaited<ReturnType<typeof deleteVaultD1Rows>>;
  try {
    d1 = await deleteVaultD1Rows(db, auth.accountId, name, deps.now?.() ?? new Date());
  } catch (err) {
    console.error(
      `event=vault_identity_cleanup_failed vault=${name} error=${JSON.stringify(err instanceof Error ? err.message : String(err))}`,
    );
    return restError(
      500,
      "d1_cleanup_failed",
      "Vault storage was destroyed, but identity cleanup did not finish. Retry the delete request.",
    );
  }

  // Ops audit line — the only durable record that a tenant's vault was torn
  // down (the rows that would have shown it are exactly what just got deleted).
  console.log(
    `event=vault_deleted vault=${name} owner=${auth.accountId} r2_objects_deleted=${destroyBody.r2_objects_deleted} ` +
      `vault_rows=${d1.vaultRowsDeleted} usage_rows=${d1.usageRowsDeleted} snapshot_rows=${d1.snapshotRowsDeleted} ` +
      `tokens_revoked=${d1.tokensRevoked} grants_rewritten=${d1.grantsRewritten} grants_dropped=${d1.grantsDropped}`,
  );

  return jsonResponse(
    {
      destroyed: true,
      r2_objects_deleted: destroyBody.r2_objects_deleted,
      d1: {
        vault_rows_deleted: d1.vaultRowsDeleted,
        vault_usage_rows_deleted: d1.usageRowsDeleted,
        vault_snapshot_rows_deleted: d1.snapshotRowsDeleted,
        tokens_revoked: d1.tokensRevoked,
        grants_rewritten: d1.grantsRewritten,
        grants_dropped: d1.grantsDropped,
      },
    },
    200,
    { "cache-control": "no-store" },
  );
}

// --- POST /account/vaults/<name>/token — per-vault mint ----------------------

/**
 * Mint a vault token for an OWNED vault — the OAuth-redirect bypass, and the
 * fallback for a create whose inline `vault_token` was empty. Ownership-gated
 * (`userOwnsVault` — an unowned OR unknown vault gets ONE 403, no existence
 * oracle) and scope-validated (`@openparachute/door-contract`'s
 * `validateVaultScopes`, hub-parity P3): every requested scope must be exactly
 * `vault:<thisName>:{read,write,admin}` (a foreign vault name, a non-vault
 * scope, or a bad verb → 400 `invalid_scope`, blocking injection). Absent,
 * `null`, OR an explicit empty array all default to `read write` — BEHAVIOR
 * DELTA (P3): cloud used to 400 `invalid_scope` on an explicit `[]`; the
 * P0-pinned shared semantics now treat it the same as omitting `scopes`
 * entirely (hub's prior lenient reading). Scope: `account:<id>:admin`.
 */
export async function handleAccountVaultTokenMint(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const auth = await requireAccount(db, req, deps, "admin");
  if (!auth.ok) return auth.response;

  const name = vaultNameFromPath(req, "/token");
  if (!name) return restError(404, "not_found", "no such vault route");

  // Ownership: false for BOTH "owned by someone else" and "doesn't exist" — one
  // 403 for both, so the response is not an existence oracle.
  if (!(await userOwnsVault(db, auth.accountId, name))) {
    return restError(403, "not_owner", `You do not own a vault named "${name}".`);
  }

  const body = await readJsonBody(req);
  const scopeResult = validateVaultScopes(body.scopes, name);
  if (!scopeResult.ok) {
    // Map the shared canon's two rejection reasons onto cloud's PRE-EXISTING
    // single wire response (hub-parity P3). Cloud's own validator never
    // distinguished a structural failure (non-array / non-string entry) from a
    // content failure (well-formed but wrong scope) — both hit exactly this one
    // 400 `invalid_scope` `{error, message}` shape (verified against cloud's own
    // prior `validateVaultScopes` + the existing test suite, which only ever
    // asserted `invalid_scope`). So BOTH `invalid_request` and `invalid_scope`
    // from the shared validator land here unchanged — this preserves "cloud's
    // HTTP error codes are unchanged", not a new split cloud never had.
    return restError(400, "invalid_scope", `scopes must each be vault:${name}:{read,write,admin}`);
  }

  const minted = await mintVaultToken(db, deps, auth.accountId, name, scopeResult.scopes);
  return jsonResponse(
    {
      vault_token: minted.token,
      expires_at: minted.expiresAt,
      services: buildServicesCatalog(scopeResult.scopes, deps),
    },
    200,
    { "cache-control": "no-store" },
  );
}

// `validateVaultScopes` is now the ONE shared implementation
// (`@openparachute/door-contract`, hub-parity P3) replacing this file's former
// local copy — re-exported here so existing importers (`test/account-api.test.ts`)
// don't need to retarget their import path. Behavior delta from cloud's prior
// local version: explicit `[]` now maps to the vault's default read+write pair
// instead of rejecting (the P0-pinned semantics; see the call site's comment for
// how the resulting reason still lands on cloud's unchanged 400 `invalid_scope`).
export { validateVaultScopes };

/**
 * Mint one tenant-facing vault token: `aud=vault.<name>`, `vault_scope=[name]`,
 * `client_id="parachute-account"` (NOT the first-party console id — see the
 * module note), the standard access-token TTL, stateless (no registry row). The
 * same `signAccessToken` the vault-call.ts seam uses, but returned to the caller
 * instead of spent server-side.
 */
async function mintVaultToken(
  db: D1Database,
  deps: OAuthDeps,
  userId: string,
  vaultName: string,
  scopes: string[],
): Promise<{ token: string; expiresAt: string }> {
  const signed = await signAccessToken(db, {
    sub: userId,
    scopes,
    audience: `vault.${vaultName}`,
    clientId: ACCOUNT_TOKEN_CLIENT_ID,
    issuer: deps.issuer,
    vaultScope: [vaultName],
    ttlSeconds: ACCOUNT_VAULT_TOKEN_TTL_SECONDS,
    now: deps.now,
  });
  return { token: signed.token, expiresAt: signed.expiresAt };
}
