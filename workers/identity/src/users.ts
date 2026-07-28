/**
 * Cloud-account users + password verification.
 *
 * DIVERGENCE (conscious, documented): the hub hashes passwords with argon2
 * (`argonHash`/`argonVerify`). argon2 needs native/WASM that the Workers runtime
 * doesn't ship, and the password store is NOT part of the OAuth wire contract —
 * it's the Identity Worker's own login surface (server-rendered HTML, forked
 * runtime per design §5's "issuer: hub ↔ Identity Worker" fork). So this uses
 * PBKDF2 via WebCrypto — see the KDF POSTURE note below (#28). Tokens, JWKS,
 * and every OAuth response are byte-identical to the hub regardless; only how a
 * login password is stored differs, and that never crosses the wire to a client.
 */
import { bytesToBase64url, randomUUID, timingSafeEqualString } from "./crypto.ts";
import { type PlanId, TRIAL_DURATION_DAYS, coercePlanId } from "./plans.ts";

const encoder = new TextEncoder();
// KDF POSTURE (#28, settled 2026-07-02 — the honest version):
//   - workerd caps PBKDF2 at 100_000 iterations at RUNTIME (`deriveBits` throws
//     NotSupportedError above it; the vitest-pool workerd does NOT enforce the
//     cap, so 210k passed 42/42 tests while every live login 500'd). 100k is
//     the ceiling on this runtime, and there is no argon2/scrypt without a
//     WASM dependency we've chosen not to take on. We do not pretend otherwise.
//   - New verifiers are PBKDF2-SHA512 at the 100k cap (the marginal upgrade
//     that IS available); legacy `pbkdf2$sha256$…` verifiers keep verifying
//     (the format is versioned — algorithm + iteration count live in the hash)
//     and are transparently re-hashed on the next successful password login
//     (`needsRehash` + setPassword at both login-submit paths).
//   - The REAL defenses are architectural, not the KDF: passwords are an
//     OPTIONAL SECONDARY factor (magic-link is the passwordless primary; a
//     fresh account stores an empty hash), online guessing is blunted by the
//     DO-backed rate limiter (#30), optional TOTP 2FA gates both login paths,
//     and the D1 password store never crosses the wire.
// NEVER raise the iteration count above 100000 — verifyPassword derives with
// the STORED count, so any hash written above the cap becomes unverifiable on
// the live worker.
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_MAX_ITERATIONS = 100_000;
/** Versioned-format tag → WebCrypto hash name. Legacy sha256 stays verifiable. */
const PBKDF2_HASH_ALGS: Record<string, string> = { sha256: "SHA-256", sha512: "SHA-512" };
const PBKDF2_CURRENT_TAG = "sha512";

/** Account role (migration 0011). 'operator' unlocks the /admin console. */
export type UserRole = "user" | "operator";

/**
 * Coerce a stored role to a known UserRole. Unknown/garbage values degrade to
 * 'user' — the safe direction: never grant operator powers the code doesn't
 * know about (mirrors coercePlanId).
 */
export function coerceRole(raw: string | null | undefined): UserRole {
  return raw === "operator" ? "operator" : "user";
}

export interface User {
  id: string;
  email: string;
  /** PBKDF2 verifier, or "" for a passwordless (magic-link) account. */
  passwordHash: string;
  createdAt: string;
  /** True once a magic link to this address has been consumed (or seeded). */
  emailVerified: boolean;
  /** Billing plan (entitlements in plans.ts). Migration 0009; default 'free'. */
  plan: PlanId;
  /** Account role (migration 0011). Set ONLY by scripts/set-operator-role.ts. */
  role: UserRole;
  /**
   * ISO-8601 timestamp when an operator suspended the account; null = active.
   * Semantics are documented on migration 0011: sessions die on next request,
   * login/magic answer neutrally without minting, tokens expire naturally,
   * vault data untouched.
   */
  suspendedAt: string | null;
  /**
   * ISO-8601 timestamp when the account entered its 24-hour delete-undo
   * window (migration 0023); null = not deleted. A-1 (this substrate) never
   * WRITES this — only reads it, at the read-time refusal chokepoints
   * documented on the migration. Set by the future `DELETE /account` route
   * (A-3), cleared by the undo endpoint (A-4).
   */
  deletedAt: string | null;
  /** Opaque hash of the mailed undo token (migration 0023). Unused until the
   *  delete route (A-3) starts writing it. */
  deleteUndoHash: string | null;
  /** ISO-8601 timestamp the deletion-notice email was sent (migration 0023).
   *  Unused until the delete route (A-3) starts writing it. */
  deleteNoticeSentAt: string | null;
  /**
   * Stripe linkage (migration 0012) — set by the checkout.session.completed
   * webhook; null for free users and comped accounts. The lifecycle handlers
   * resolve events by these ids (billing-lifecycle.ts).
   */
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  /**
   * The deferred-downgrade pair (migration 0012, old lifecycle.ts semantics):
   * `customer.subscription.deleted` records pending_plan='free' +
   * plan_downgrade_at = paid-through end + 3-day grace; the hourly billing
   * sweep applies it. `pendingPlan` alone (no timestamp) = a scheduled
   * cancel_at_period_end, informational until `deleted` stamps the time.
   */
  pendingPlan: PlanId | null;
  planDowngradeAt: string | null;
  /** Soft dunning (migration 0012): flags only, never auto-suspend. */
  lastInvoicePaidAt: string | null;
  paymentFailedAt: string | null;
  paymentFailedCount: number;
  /**
   * The owners row this account has claimed a handle through (migration 0022,
   * the GitHub owner-model); null until the account claims one (claiming is
   * optional + Settings-initiated). Resolve to the handle string via
   * `getOwnerHandle` (handles.ts). Written only by `claimHandle`.
   */
  ownerId: string | null;
}

interface Row {
  id: string;
  email: string;
  password_hash: string;
  created_at: string;
  email_verified: number;
  plan: string;
  role: string;
  suspended_at: string | null;
  deleted_at: string | null;
  delete_undo_hash: string | null;
  delete_notice_sent_at: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  pending_plan: string | null;
  plan_downgrade_at: string | null;
  last_invoice_paid_at: string | null;
  payment_failed_at: string | null;
  payment_failed_count: number;
  owner_id: string | null;
}

function rowToUser(r: Row): User {
  return {
    id: r.id,
    email: r.email,
    passwordHash: r.password_hash,
    createdAt: r.created_at,
    emailVerified: r.email_verified === 1,
    // Defensive coercion: an unknown stored value degrades to 'free' rather
    // than granting entitlements this build doesn't know about.
    plan: coercePlanId(r.plan),
    role: coerceRole(r.role),
    suspendedAt: r.suspended_at,
    deletedAt: r.deleted_at,
    deleteUndoHash: r.delete_undo_hash,
    deleteNoticeSentAt: r.delete_notice_sent_at,
    stripeCustomerId: r.stripe_customer_id,
    stripeSubscriptionId: r.stripe_subscription_id,
    // Same defensive coercion as `plan`; null stays null (no pending change).
    pendingPlan: r.pending_plan === null ? null : coercePlanId(r.pending_plan),
    planDowngradeAt: r.plan_downgrade_at,
    lastInvoicePaidAt: r.last_invoice_paid_at,
    paymentFailedAt: r.payment_failed_at,
    paymentFailedCount: r.payment_failed_count,
    ownerId: r.owner_id,
  };
}

/** Whether this account can log in with a password (magic-link signups can't, until they set one). */
export function hasPassword(user: User): boolean {
  return user.passwordHash.length > 0;
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number, hash: string): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash },
    keyMaterial,
    256,
  );
  return bytesToBase64url(new Uint8Array(bits));
}

/** `pbkdf2$sha512$<iterations>$<salt-b64url>$<derived-b64url>`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const derived = await pbkdf2(password, salt, PBKDF2_ITERATIONS, PBKDF2_HASH_ALGS[PBKDF2_CURRENT_TAG]!);
  return `pbkdf2$${PBKDF2_CURRENT_TAG}$${PBKDF2_ITERATIONS}$${bytesToBase64url(salt)}$${derived}`;
}

/**
 * A verifier stored under a superseded format (legacy sha256) that should be
 * transparently re-hashed after the next successful password verification.
 */
export function needsRehash(user: User): boolean {
  const tag = user.passwordHash.split("$")[1];
  return tag !== undefined && tag in PBKDF2_HASH_ALGS && tag !== PBKDF2_CURRENT_TAG;
}

export async function verifyPassword(user: User, password: string): Promise<boolean> {
  const parts = user.passwordHash.split("$");
  if (parts.length !== 5 || parts[0] !== "pbkdf2") return false;
  // The format is versioned: derive with the STORED algorithm + iteration
  // count, so legacy sha256 verifiers keep working after the sha512 bump.
  const hashAlg = PBKDF2_HASH_ALGS[parts[1] ?? ""];
  const iterations = Number(parts[2]);
  const saltB64 = parts[3];
  const expected = parts[4];
  if (!hashAlg || !Number.isFinite(iterations) || iterations < 1 || iterations > PBKDF2_MAX_ITERATIONS || !saltB64 || !expected) {
    return false;
  }
  const salt = base64urlToBytes(saltB64);
  // deriveBits can still throw (malformed salt, platform crypto error) — treat any
  // failure as a failed verification rather than a 500 on the login form.
  try {
    const derived = await pbkdf2(password, salt, iterations, hashAlg);
    return timingSafeEqualString(derived, expected);
  } catch {
    return false;
  }
}

function base64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Create a user. An empty `password` produces a passwordless (magic-link)
 * account — stored as an empty hash, which `verifyPassword` rejects, so password
 * login fails until one is set via {@link setPassword}. `emailVerified` starts
 * true for a magic-link signup (the link proves the address).
 *
 * EVERY new account STARTS THE NO-CARD TRIAL (the pricing model — there is no
 * perpetual free tier; self-host is the free-forever option). Its LENGTH is
 * plans.ts `TRIAL_DURATION_DAYS` — 90 days, the "three months free" campaign
 * (2026-07-25) — and this is the only place it's stamped. We write the full
 * trial state machine right here so BOTH signup paths (password /signup and the
 * first magic-link, auth-handlers.ts) land on it identically:
 *   - plan            = 'trial'   (mirrors PLUS entitlements — full experience)
 *   - pending_plan    = 'expired' (the floor the hourly sweep flips to when due)
 *   - plan_downgrade_at = now + TRIAL_DURATION_DAYS (when the sweep applies it)
 * A fresh account owns no vaults yet, so there is nothing to push caps into
 * here — the vault-creation path (console.ts) pushes the trial entitlement as
 * each vault is made; the sweep + any checkout/comp re-push on a plan change.
 */
export async function createUser(
  db: D1Database,
  email: string,
  password: string,
  now: Date = new Date(),
  opts: { emailVerified?: boolean } = {},
): Promise<User> {
  const id = randomUUID();
  // NEVER hash an empty password — an empty hash means "no password", which
  // verifyPassword refuses. Hashing "" would produce a hash the empty string
  // verifies against.
  const passwordHash = password.length > 0 ? await hashPassword(password) : "";
  const emailVerified = opts.emailVerified ?? false;
  const createdAt = now.toISOString();
  const planDowngradeAt = new Date(now.getTime() + TRIAL_DURATION_DAYS * 86_400_000).toISOString();
  // `role` is deliberately NOT in the INSERT (migration DEFAULT 'user'); `plan`
  // + the trial pair ARE written explicitly so the state machine is set the
  // same way regardless of the migration DEFAULT.
  await db
    .prepare(
      `INSERT INTO users (id, email, password_hash, created_at, email_verified, plan, pending_plan, plan_downgrade_at)
       VALUES (?, ?, ?, ?, ?, 'trial', 'expired', ?)`,
    )
    .bind(id, email, passwordHash, createdAt, emailVerified ? 1 : 0, planDowngradeAt)
    .run();
  return {
    id,
    email,
    passwordHash,
    createdAt,
    emailVerified,
    plan: "trial",
    role: "user",
    suspendedAt: null,
    deletedAt: null,
    deleteUndoHash: null,
    deleteNoticeSentAt: null,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    pendingPlan: "expired",
    planDowngradeAt,
    lastInvoicePaidAt: null,
    paymentFailedAt: null,
    paymentFailedCount: 0,
    // A fresh account holds no handle — claiming is optional + Settings-
    // initiated (migration 0022); the INSERT omits owner_id (column default NULL).
    ownerId: null,
  };
}

/** Mark an account's email verified (idempotent). */
export async function markEmailVerified(db: D1Database, userId: string): Promise<void> {
  await db.prepare("UPDATE users SET email_verified = 1 WHERE id = ?").bind(userId).run();
}

/** Set (or change) an account's password — the optional secondary factor. */
export async function setPassword(db: D1Database, userId: string, password: string): Promise<void> {
  const passwordHash = await hashPassword(password);
  await db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(passwordHash, userId).run();
}

/**
 * Set a user's plan. The plan-change seam (admin / Stripe webhook, later PRs)
 * calls this then `applyPlanToVaults` (vault-call.ts) so storage caps follow
 * the entitlement. Type-narrowed to PlanId — callers validate raw input.
 */
export async function setUserPlan(db: D1Database, userId: string, plan: PlanId): Promise<void> {
  await db.prepare("UPDATE users SET plan = ? WHERE id = ?").bind(plan, userId).run();
}

/**
 * Suspend (timestamp) or un-suspend (null) an account — the /admin moderation
 * lever. Suspension semantics live on migration 0011; the CALLER (admin.ts)
 * also deletes the user's session rows on suspend, and findActiveSession
 * (sessions.ts) refuses suspended users' sessions as the read-time backstop.
 */
export async function setUserSuspended(db: D1Database, userId: string, suspendedAt: Date | null): Promise<void> {
  await db
    .prepare("UPDATE users SET suspended_at = ? WHERE id = ?")
    .bind(suspendedAt ? suspendedAt.toISOString() : null, userId)
    .run();
}

export async function getUserByEmail(db: D1Database, email: string): Promise<User | null> {
  const row = await db.prepare("SELECT * FROM users WHERE email = ? COLLATE NOCASE").bind(email).first<Row>();
  return row ? rowToUser(row) : null;
}

export async function getUserById(db: D1Database, id: string): Promise<User | null> {
  const row = await db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<Row>();
  return row ? rowToUser(row) : null;
}

/**
 * Webhook-side lookups (billing-lifecycle.ts): invoice.* events resolve by
 * `customer`, customer.subscription.* by the subscription id — both set on the
 * row at checkout.session.completed time. Indexed (migration 0012).
 */
export async function getUserByStripeCustomerId(db: D1Database, customerId: string): Promise<User | null> {
  const row = await db.prepare("SELECT * FROM users WHERE stripe_customer_id = ?").bind(customerId).first<Row>();
  return row ? rowToUser(row) : null;
}

export async function getUserByStripeSubscriptionId(db: D1Database, subscriptionId: string): Promise<User | null> {
  const row = await db
    .prepare("SELECT * FROM users WHERE stripe_subscription_id = ?")
    .bind(subscriptionId)
    .first<Row>();
  return row ? rowToUser(row) : null;
}
