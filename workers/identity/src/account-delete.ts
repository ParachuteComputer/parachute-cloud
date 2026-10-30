/**
 * Account deletion — the A-train's A-3 (the delete + undo routes) and A-4 (the
 * convergence sweep), the wiring that finally makes A-1 and A-2 do something.
 *
 * Aaron's ruling, restated because every ordering decision below follows from
 * it: deleting an account SEVERS AUTHENTICATION IMMEDIATELY but gives a
 * 24-HOUR UNDO WINDOW before anything irreversible happens. Three moving parts,
 * each already built and until now inert:
 *
 *   - A-1 (migration 0023 + the read-time chokepoints): `users.deleted_at` is
 *     the tombstone. Every surface that can ACT on an account already refuses a
 *     tombstoned row — the bearer gate, the session JOIN, both password logins,
 *     magic-link request/consume, the /oauth/token mint (both grants), the
 *     drip, and the billing/usage/snapshot sweeps. THIS MODULE IS THE FIRST THING THAT WRITES THAT COLUMN. Because
 *     A-1 is already everywhere, the instant the tombstone lands the account
 *     stops working — that is what "severs auth immediately" means mechanically,
 *     and it is why the session/token wipe below is belt, not braces.
 *   - A-2 (billing-teardown.ts): `deferBilling` on request (reversible),
 *     `resumeBilling` on undo, `teardownBilling` at expiry (irreversible).
 *   - PR-1 + the vault-delete door (vault-call.ts `callVaultDestroy`,
 *     vaults.ts `deleteVaultD1Rows`): the only verb that actually erases tenant
 *     vault content. The sweep reuses it per owned vault rather than inventing
 *     a second teardown — which is why the vault-delete door and this land on
 *     one branch.
 *
 * THE ORDERING RULE, once, since it recurs: at REQUEST time, do the reversible
 * thing first and the durable thing second, and compensate if the second fails
 * — a hold with no tombstone is a bug we can unwind, a tombstone with no hold
 * is a charge that posts against an account the user believes is closed. At
 * SWEEP time, the reverse: billing before storage, storage before the user row,
 * and every step idempotent, so a partial pass always converges on retry and
 * never strands an un-cancelable subscription behind a deleted row that no
 * longer names it.
 *
 * NO ORACLE, with ONE deliberate exception. Every undo token that cannot be
 * used — unknown, malformed, already spent, belonging to a live account —
 * gets the SAME neutral 400, so the endpoint never confirms whether an
 * address has an account mid-deletion. The exception is a token that WAS
 * valid and whose window has since closed: that gets an honest 410
 * `undo_window_expired`. Reaching it requires having held the real token, so
 * it reveals nothing to anyone who didn't already have it, and "you're too
 * late" is the only useful thing to tell the person who did.
 *
 * The undo endpoint is the ONE account surface that must work for a user whose
 * auth was just severed, so it authenticates on the mailed token alone — never
 * a session, never a bearer, both of which A-1 now refuses by construction.
 */
import type Stripe from "stripe";
import { readJsonBody, requireAccount } from "./account-api.ts";
import { billingConfig } from "./billing-config.ts";
import type { BillingOverrides } from "./billing.ts";
import { deferBilling, resumeBilling, teardownBilling } from "./billing-teardown.ts";
import { randomBase64url, sha256Hex } from "./crypto.ts";
import type { EmailSender } from "./email.ts";
import type { Env } from "./env.ts";
import { type OAuthDeps, jsonResponse } from "./oauth-shared.ts";
import { deleteSessionsForUser } from "./sessions.ts";
import { raiseOpsAlert } from "./ops-alerts.ts";
import { makeStripe } from "./stripe-client.ts";
import { type User, getUserById } from "./users.ts";
import { applyPlanToVaults, callVaultDestroy, pushVaultsClosed, readDestroyOutcome } from "./vault-call.ts";
import { deleteVaultD1Rows, listVaultsForOwner } from "./vaults.ts";
import { type AuditActor, auditStatement, recordAudit } from "./account-audit.ts";
import { ensureCsrfToken, verifyCsrfToken } from "./csrf.ts";
import { frontDoorOrigin, htmlResponse, isSameOriginRequest, resolveBoundOrigins } from "./oauth-shared.ts";
import { humanUtc, renderUndoConfirm, renderUndoDone, renderUndoProblem } from "./account-delete-ui.ts";

/** The ratified undo window: 24 hours from the delete REQUEST (`deleted_at`). */
export const DELETE_UNDO_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Accounts converged per sweep pass. The sweep rides the hourly tick and each
 * account costs a Stripe round-trip plus one DO wake per owned vault, so this
 * caps the tail latency of a single cron invocation; the backlog drains at
 * CAP/hour, which is far above any plausible delete rate.
 */
export const ACCOUNT_DELETE_SWEEP_CAP = 25;

/** REST/business-error body (`{ error, message }`) — the `/account/*` shape. */
function deleteError(status: number, error: string, message: string): Response {
  return jsonResponse({ error, message }, status, { "cache-control": "no-store" });
}

/**
 * The Stripe client for a billing operation, or a reason there isn't one.
 * `overrides.stripe` is the test seam (billing.ts's `BillingOverrides`, the
 * same one billing-lifecycle's tests use). An environment with no billing
 * configured has no Stripe to talk to — which is FINE for an account carrying
 * no Stripe ids and NOT fine for one that does, so the caller decides.
 */
function stripeFor(env: Env, overrides?: BillingOverrides): Stripe | null {
  if (overrides?.stripe) return overrides.stripe;
  const config = billingConfig(env);
  return config ? makeStripe(config.secretKey) : null;
}

/** Whether this account has anything in Stripe that a teardown must reach. */
function hasBillingArtifacts(user: Pick<User, "stripeCustomerId" | "stripeSubscriptionId">): boolean {
  return user.stripeCustomerId !== null || user.stripeSubscriptionId !== null;
}

// --- A-3a: DELETE /account — request deletion, open the undo window ----------

/**
 * Request account deletion. Scope: `account:<id>:admin` — the same gate every
 * other `/account/*` mutation runs, and the account id comes from the bearer's
 * `sub`, never a body field, so this can only ever delete the CALLER's account.
 *
 * Guarded by a retype confirm, exactly as the vault door is: the body must
 * carry `{ "confirm": "<the account's email>" }`. The email is this surface's
 * analogue of the vault name — the one string the account holder knows and a
 * mis-aimed script does not.
 *
 * WHAT HAPPENS, in the order it happens and why:
 *
 *   1. `deferBilling` — the REVERSIBLE hold, FIRST. This is the "no new charge
 *      can post after a delete is requested" guarantee, and it must not depend
 *      on the D1 write that follows. A hard Stripe failure aborts the request
 *      with nothing written; `deferBilling` is idempotent, so a retry is safe.
 *   2. The TOMBSTONE — `deleted_at` + `delete_undo_hash`, conditional on
 *      `deleted_at IS NULL` so two concurrent requests cannot both open a
 *      window (the second sees zero changed rows and is told so). If this
 *      write fails, the hold from step 1 is COMPENSATED with `resumeBilling`
 *      before answering — the one place this module unwinds itself, because a
 *      standing cancel-at-period-end on an account that was never deleted is
 *      silent money loss nobody would think to look for.
 *   3. Auth severance — sessions dropped, unredeemed codes deleted, live
 *      tokens revoked. Belt, not braces: A-1's chokepoints already refuse a
 *      tombstoned account at every read path, /oauth/token included (its
 *      closed-account mint gate covers both grants), so the account is dead
 *      the instant step 2 commits whether or not this succeeds. It runs anyway
 *      so the rows don't sit there spendable-looking for a day, and so what it
 *      revokes stays revoked after an undo. A failure is logged, not fatal —
 *      failing the request here would be the worst outcome, since the delete
 *      HAS taken effect.
 *   4. The notice email, carrying the undo link. Non-fatal for the same
 *      reason; `delete_notice_sent_at` is stamped only on a real send, so the
 *      column never claims an email that didn't go out.
 *
 * The undo token is returned in the response body as well as mailed. That is
 * deliberate: the caller is the authenticated account admin who just asked for
 * this, so the body tells them nothing they didn't just prove they're entitled
 * to — and an API client (which may have no inbox at all) can offer undo
 * without depending on email delivery.
 *
 * VAULT DATA IS UNTOUCHED HERE. Nothing tenant-visible is erased until the
 * window closes and the sweep runs ({@link runAccountDeleteSweep}); during the
 * window the data is intact but unreachable, because every read path already
 * refuses a tombstoned owner. That is the whole point of the window.
 */
export async function handleAccountDelete(
  env: Env,
  req: Request,
  deps: OAuthDeps,
  sender?: EmailSender,
  overrides?: BillingOverrides,
): Promise<Response> {
  const auth = await requireAccount(env.DB, req, deps, "admin");
  if (!auth.ok) return auth.response;
  const user = auth.user;

  const body = await readJsonBody(req);
  if (!confirmMatchesEmail(body.confirm, user.email)) {
    return deleteError(
      400,
      "confirm_mismatch",
      `deleting an account requires the body {"confirm": "${user.email}"}`,
    );
  }

  const outcome = await requestAccountDeletion(env, deps, user, { sender, overrides, actor: "self" });
  if (!outcome.ok) return deleteError(outcome.status, outcome.error, outcome.message);
  return jsonResponse(
    {
      deleted: true,
      deleted_at: outcome.deletedAt,
      undo_expires_at: outcome.undoExpiresAt,
      undo_token: outcome.undoToken,
      undo_url: outcome.undoUrl,
      notice_sent: outcome.noticeSent,
    },
    200,
    { "cache-control": "no-store" },
  );
}

/** The retype guard, shared by the API and the operator action: trimmed,
 *  case-insensitive equality with the account email. */
export function confirmMatchesEmail(confirm: unknown, email: string): boolean {
  return typeof confirm === "string" && confirm.trim().toLowerCase() === email.trim().toLowerCase();
}

export type DeletionRequestOutcome =
  | {
      ok: true;
      deletedAt: string;
      undoExpiresAt: string;
      undoToken: string;
      undoUrl: string;
      noticeSent: boolean;
      vaultsLocked: number;
      vaultsLockFailed: number;
    }
  | { ok: false; status: number; error: string; message: string };

/**
 * The delete REQUEST, after the caller is authenticated and the retype guard
 * has passed — the ONE path both the account holder (`handleAccountDelete`)
 * and the operator action for an emailed request (admin.ts) drive, so an
 * operator-filed deletion gets exactly the same hold, tombstone, severance,
 * vault lock, 24-hour undo window and notice email as a self-service one.
 * `actor` only changes the audit row and the log line.
 */
export async function requestAccountDeletion(
  env: Env,
  deps: OAuthDeps,
  user: User,
  opts: { sender?: EmailSender; overrides?: BillingOverrides; actor: AuditActor },
): Promise<DeletionRequestOutcome> {
  const { sender, overrides, actor } = opts;
  const fail = (status: number, error: string, message: string): DeletionRequestOutcome => ({
    ok: false,
    status,
    error,
    message,
  });

  // 1. The reversible hold, before anything durable.
  const stripe = stripeFor(env, overrides);
  if (user.stripeSubscriptionId !== null) {
    if (!stripe) {
      return fail(
        503,
        "billing_not_configured",
        "This account has a subscription but billing is not configured here, so the hold that stops new charges cannot be placed. Deletion was not started.",
      );
    }
    try {
      await deferBilling(stripe, user.stripeSubscriptionId);
    } catch (err) {
      console.error(
        `event=account_delete_hold_failed user=${user.id} error=${err instanceof Error ? err.message : String(err)}`,
      );
      return fail(
        502,
        "billing_hold_failed",
        "Billing could not be paused, so deletion was not started. Nothing changed; retry the request.",
      );
    }
  }

  // 2. The tombstone — the durable fact that makes the account deleted.
  const now = deps.now?.() ?? new Date();
  const nowIso = now.toISOString();
  const undoToken = randomBase64url(32);
  const undoHash = await sha256Hex(undoToken);
  let changed = 0;
  try {
    const res = await env.DB
      // `delete_purge_claimed_at = NULL` is hygiene, not a no-op: a NEW window
      // means fresh restorability, and this is the only writer that opens one.
      // A row reached here has `deleted_at IS NULL` (the CAS), so it cannot be
      // an account a sweep is mid-purge on — the claim being cleared here can
      // only ever be residue from a previous cycle that ended outside this
      // module (an operator SQL restore, say). Without it, such an account
      // would re-delete straight into an unrestorable state.
      .prepare(
        "UPDATE users SET deleted_at = ?, delete_undo_hash = ?, delete_purge_claimed_at = NULL WHERE id = ? AND deleted_at IS NULL",
      )
      .bind(nowIso, undoHash, user.id)
      .run();
    changed = res.meta.changes ?? 0;
  } catch (err) {
    console.error(
      `event=account_delete_tombstone_failed user=${user.id} error=${err instanceof Error ? err.message : String(err)}`,
    );
    // Compensate the step-1 hold — see the ordering note above.
    if (stripe && user.stripeSubscriptionId !== null) {
      try {
        await resumeBilling(stripe, user.stripeSubscriptionId);
      } catch (resumeErr) {
        // BOTH halves failed: the subscription is now sitting at
        // cancel_at_period_end = true for an account that was NOT deleted, and
        // nothing in the system will ever revisit it — the user's next attempt
        // starts from scratch, the sweep only looks at tombstoned rows, and
        // there is no tombstone. The user finds out when their subscription
        // lapses at the period boundary for no reason they can see. That is
        // exactly the invisible-money-loss shape that earns the alert channel
        // rather than a log line (ops-alerts.ts).
        await raiseOpsAlert(env, sender, {
          key: `billing-hold-stuck:${user.id}`,
          subject: "billing hold stuck on a NON-deleted account",
          text: [
            `A delete request placed a cancel_at_period_end hold, then failed to`,
            `record the deletion AND failed to release the hold.`,
            ``,
            `  account:      ${user.id}`,
            `  subscription: ${user.stripeSubscriptionId}`,
            `  release error: ${resumeErr instanceof Error ? resumeErr.message : String(resumeErr)}`,
            ``,
            `This account is NOT deleted and has no tombstone, so no sweep will`,
            `ever revisit it. Its subscription will silently lapse at the period`,
            `boundary unless someone clears cancel_at_period_end in Stripe`,
            `(and removes its parachute_delete_hold metadata key).`,
          ].join("\n"),
          now: deps.now?.() ?? new Date(),
        });
      }
    }
    return fail(
      500,
      "delete_request_failed",
      "The deletion could not be recorded. Nothing was deleted; retry the request.",
    );
  }
  if (changed === 0) {
    // requireAccount already refuses a tombstoned account, so reaching here
    // means a concurrent request won the race — report it rather than minting
    // a second undo token that would silently orphan the first.
    return fail(409, "already_deleting", "This account is already scheduled for deletion.");
  }

  // 3. Sever the credentials that exist right now (belt — see the doc above;
  //    /oauth/token refuses a tombstoned subject on its own, so a failure
  //    here leaves nothing spendable). Unredeemed codes go before the token
  //    revoke so a redemption that read the account live a moment before the
  //    tombstone either loses its code (and the token endpoint's "code still
  //    granted" fence refuses it) or inserted its token before the revoke
  //    below, which then catches it — either way nothing it minted survives
  //    an undo. Each step is attempted on its own, so one failure doesn't
  //    skip the others.
  const severance: Array<[step: string, run: () => Promise<unknown>]> = [
    ["sessions", () => deleteSessionsForUser(env.DB, user.id)],
    ["auth_codes", () => env.DB.prepare("DELETE FROM auth_codes WHERE user_id = ?").bind(user.id).run()],
    [
      "tokens",
      () =>
        env.DB
          .prepare("UPDATE tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
          .bind(nowIso, user.id)
          .run(),
    ],
  ];
  for (const [step, run] of severance) {
    try {
      await run();
    } catch (err) {
      console.error(
        `event=account_delete_severance_incomplete user=${user.id} step=${step} error=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 3b. Lock every owned vault (T-318). The tombstone already stops every
  //     identity-side credential, but the vault tokens this worker hands out
  //     are STATELESS (15-minute JWTs with no registry row), so neither the
  //     tombstone nor the token revocation above reaches them — before this,
  //     a deleted account's vault stayed readable and writable until those
  //     tokens expired. The DO refuses every tenant request while locked;
  //     undo unlocks it. Best-effort for the same reason step 3 is.
  let vaultsLocked = 0;
  let vaultsLockFailed = 0;
  try {
    for (const r of await pushVaultsClosed(env.DB, deps, user.id, true)) {
      if (r.ok) vaultsLocked++;
      else vaultsLockFailed++;
    }
  } catch (err) {
    console.error(
      `event=account_delete_vault_lock_failed user=${user.id} error=${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 4. The notice, carrying the way back.
  const purgeAt = new Date(now.getTime() + DELETE_UNDO_WINDOW_MS);
  const undoUrl = `${deps.issuer}/account/undo-delete?token=${encodeURIComponent(undoToken)}`;
  let noticeSent = false;
  if (sender) {
    // TRANSPORT NOTE: this rides `sendOps` — plain text, no List-Unsubscribe
    // headers, which is CORRECT for a transactional deletion notice (an
    // unsubscribable "your account is closing" email would be a bug). What it
    // does not yet have is a branded template like the magic-link and drip
    // sends; that is presentation work, deliberately not blocking the door.
    const result = await sender.sendOps({
      to: user.email,
      subject: "Your Parachute account is scheduled for deletion",
      text: [
        `We received a request to delete the Parachute account for ${user.email}.`,
        ``,
        `Your account is now closed and you have been signed out everywhere.`,
        `Nothing has been erased yet.`,
        ``,
        `You have until ${humanUtc(purgeAt.toISOString())} (24 hours) to change your mind.`,
        `After that, your vaults and their contents are permanently deleted and`,
        `cannot be recovered.`,
        ``,
        `To restore your account, open this link before then:`,
        `${undoUrl}`,
        ``,
        `If you did not request this, restore your account now, and check who`,
        `else can read this email inbox.`,
      ].join("\n"),
    });
    if (result.ok) {
      noticeSent = true;
      try {
        await env.DB.prepare("UPDATE users SET delete_notice_sent_at = ? WHERE id = ?").bind(nowIso, user.id).run();
      } catch {
        // The email really went out; failing to stamp it is a bookkeeping
        // miss, not a reason to tell the user their deletion failed.
      }
    } else {
      console.error(`event=account_delete_notice_failed user=${user.id} error=${result.error}`);
    }
  }

  await recordAudit(env.DB, {
    actor,
    action: "delete_requested",
    userId: user.id,
    note: { notice_sent: noticeSent, vaults_locked: vaultsLocked, vaults_lock_failed: vaultsLockFailed },
    now,
  });
  console.log(
    `event=account_delete_requested user=${user.id} actor=${actor} purge_at=${purgeAt.toISOString()} notice_sent=${noticeSent} vaults_locked=${vaultsLocked} vaults_lock_failed=${vaultsLockFailed}`,
  );
  return {
    ok: true,
    deletedAt: nowIso,
    undoExpiresAt: purgeAt.toISOString(),
    undoToken,
    undoUrl,
    noticeSent,
    vaultsLocked,
    vaultsLockFailed,
  };
}

// --- A-3b: /account/undo-delete — the way back, inside the window ------------

/** Why an undo token cannot be used, in the module's no-oracle vocabulary. */
type UndoRefusal = { ok: false; status: number; error: string; message: string };

const UNDO_INVALID: UndoRefusal = {
  ok: false,
  status: 400,
  error: "invalid_undo_token",
  message: "That restore link is not valid.",
};
const UNDO_EXPIRED: UndoRefusal = {
  ok: false,
  status: 410,
  error: "undo_window_expired",
  message: "The 24-hour window to restore this account has passed and its data has been deleted.",
};

/**
 * Resolve a raw undo token to the account it can restore, or the refusal.
 * READ-ONLY — the shared first half of the preview (GET) and the restore
 * (POST), so the page a person sees and the action they take agree on
 * validity by construction.
 */
async function resolveUndoToken(
  env: Env,
  deps: OAuthDeps,
  raw: string | null,
): Promise<{ ok: true; user: User; expiresAt: string } | UndoRefusal> {
  if (!raw) return UNDO_INVALID;
  const hash = await sha256Hex(raw);
  const row = await env.DB
    .prepare("SELECT id FROM users WHERE delete_undo_hash = ?")
    .bind(hash)
    .first<{ id: string }>();
  if (!row) return UNDO_INVALID;
  const user = await getUserById(env.DB, row.id);
  if (!user || user.deletedAt === null) return UNDO_INVALID;

  const now = deps.now?.() ?? new Date();
  const requestedAtMs = Date.parse(user.deletedAt);
  // An unparseable timestamp is corruption, not an open window — refuse to
  // treat it as restorable rather than guessing which side of the line it's on.
  if (!Number.isFinite(requestedAtMs) || now.getTime() - requestedAtMs >= DELETE_UNDO_WINDOW_MS) {
    return UNDO_EXPIRED;
  }

  // cloud#248: the clock said the window is open; the SWEEP may already have
  // said otherwise. Its claim is authoritative over both our clock and its own
  // — once it is set, irreversible teardown has begun and there is nothing
  // left to restore. 410, not the neutral 400: reaching it requires having
  // held the real, unspent token for an account whose window has in fact
  // closed, so it tells that holder nothing they did not already have (the
  // module's stated no-oracle exception).
  if (user.deletePurgeClaimedAt !== null) {
    console.log(`event=account_undo_lost_to_purge user=${user.id} claimed_at=${user.deletePurgeClaimedAt}`);
    return UNDO_EXPIRED;
  }
  return { ok: true, user, expiresAt: new Date(requestedAtMs + DELETE_UNDO_WINDOW_MS).toISOString() };
}

type RestoreOutcome = { ok: true; billingResumed: boolean; billingNote: "already_canceled" | null } | UndoRefusal;

/**
 * Restore an account inside its undo window — the mutation, reached ONLY by a
 * POST (T-318: a GET never mutates, because mail link scanners prefetch).
 *
 * The tombstone-clear CAS is the atomic winner BEFORE billing resumes. That
 * ordering is load-bearing: if Stripe ran first, the sweep could claim during
 * that await, leaving a purged account with a resumed subscription. A hard
 * Stripe failure compensates by restoring the original tombstone + undo token,
 * so the account remains honestly deleted and the same link can retry.
 * After the tombstone clears, current plan entitlement is pushed to owned
 * vaults (cloud#234), and that same push re-opens the vault lock the delete
 * request set (`applyPlanToVaults(..., { reopen: true })` adds `closed: false`).
 *
 * The one case that cannot be undone is reported, not hidden: if the billing
 * period boundary passed during the window, Stripe already canceled for real
 * and there is no un-cancel ({@link resumeBilling}'s `already_canceled`). The
 * account still restores, and the result says billing did not come back.
 *
 * Sessions are NOT restored (they were deleted, not tombstoned): a restored
 * user signs in again. That is the safe direction and it costs one magic link.
 */
async function restoreAccount(
  env: Env,
  deps: OAuthDeps,
  raw: string | null,
  overrides?: BillingOverrides,
): Promise<RestoreOutcome> {
  const resolved = await resolveUndoToken(env, deps, raw);
  if (!resolved.ok) return resolved;
  const user = resolved.user;

  const stripe = stripeFor(env, overrides);
  if (user.stripeSubscriptionId !== null && !stripe) {
    return {
      ok: false,
      status: 503,
      error: "billing_not_configured",
      message:
        "Billing is not configured here, so this account's subscription cannot be resumed. The account was not restored; retry later.",
    };
  }

  // THE ATOMIC WINNER. Clear the tombstone before any external side effect so
  // a sweep selected just before this line loses its exact-tombstone claim.
  const res = await env.DB
    .prepare(
      "UPDATE users SET deleted_at = NULL, delete_undo_hash = NULL, delete_notice_sent_at = NULL WHERE id = ? AND deleted_at = ? AND delete_undo_hash = ? AND delete_purge_claimed_at IS NULL",
    )
    .bind(user.id, user.deletedAt, user.deleteUndoHash)
    .run();
  if ((res.meta.changes ?? 0) === 0) return UNDO_INVALID;

  let billingResumed = true;
  let billingNote: "already_canceled" | null = null;
  if (user.stripeSubscriptionId !== null) {
    try {
      const result = await resumeBilling(stripe!, user.stripeSubscriptionId);
      if (!result.resumed) {
        billingResumed = false;
        billingNote = result.reason;
      }
    } catch (err) {
      // Restore the exact deletion window we won above. While the tombstone was
      // NULL no sweep could claim it, and the delete request revoked every user
      // credential, so no ordinary concurrent writer can open a new window.
      const rollback = await env.DB
        .prepare(
          "UPDATE users SET deleted_at = ?, delete_undo_hash = ?, delete_notice_sent_at = ? WHERE id = ? AND deleted_at IS NULL AND delete_undo_hash IS NULL AND delete_purge_claimed_at IS NULL",
        )
        .bind(user.deletedAt, user.deleteUndoHash, user.deleteNoticeSentAt, user.id)
        .run();
      if ((rollback.meta.changes ?? 0) === 0) {
        console.error(`event=account_undo_rollback_failed user=${user.id}`);
        return {
          ok: false,
          status: 500,
          error: "undo_rollback_failed",
          message:
            "Billing could not be resumed and the account restore could not be rolled back safely. Support has been notified.",
        };
      }
      console.error(
        `event=account_undo_billing_failed user=${user.id} error=${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        ok: false,
        status: 502,
        error: "billing_resume_failed",
        message: "Billing could not be resumed, so the account was not restored. Nothing changed; retry the request.",
      };
    }
  }

  // cloud#234 + T-318: re-apply plan entitlement now that the tombstone is
  // gone — and with it `closed: false`, which unlocks the vaults the delete
  // request locked. Best effort; a vault whose push failed gets one more,
  // lock-only attempt; after that the 03:30 entitlement reconciler reopens any
  // vault still locked for a live owner (usage.ts), or an operator plan set in
  // /admin/users does it at once. Failing undo over it would strand a
  // restored account behind a 5xx.
  const capResults = await applyPlanToVaults(env.DB, deps, user.id, { reopen: true });
  const capFailed = capResults.filter((r) => !r.ok);
  if (capFailed.length > 0) {
    console.warn(
      `event=account_undo_plan_push_partial user=${user.id} failed=${capFailed.map((f) => f.vault).join(",")}`,
    );
    await pushVaultsClosed(env.DB, deps, user.id, false).catch(() => []);
  }

  await recordAudit(env.DB, {
    actor: "self",
    action: "delete_undone",
    userId: user.id,
    note: { billing_resumed: billingResumed, vaults: capResults.length },
    now: deps.now?.() ?? new Date(),
  });
  console.log(`event=account_delete_undone user=${user.id} billing_resumed=${billingResumed} vaults=${capResults.length}`);
  return { ok: true, billingResumed, billingNote };
}

/** Does this request want the JSON API rather than a page? */
function wantsJson(req: Request): boolean {
  const ct = (req.headers.get("content-type") ?? "").toLowerCase();
  if (req.method === "POST") return ct.includes("application/json");
  const accept = (req.headers.get("accept") ?? "").toLowerCase();
  return accept.includes("application/json") && !accept.includes("text/html");
}

const NO_STORE = { "cache-control": "no-store" };

/**
 * `/account/undo-delete` — the way back, inside the window. Authenticated by
 * the mailed token ALONE — no session, no bearer — because A-1 refuses both
 * for a tombstoned account, so any other credential would make undo
 * structurally impossible.
 *
 * T-318 split it by verb, because mail link scanners PREFETCH:
 *
 *   - GET `?token=` (the link in the notice email) NEVER mutates. A browser
 *     gets a calm page saying what will come back, with a "Restore my
 *     account" button that POSTs the token; an API caller (`Accept:
 *     application/json`) gets `{ restorable, undo_expires_at }`.
 *   - POST with a JSON body `{ "token" }` is the API restore (the app),
 *     answering the JSON shape it always has.
 *   - POST from the page's form restores and renders the result page. It
 *     carries the console's write boundary: the double-submit CSRF cookie the
 *     GET set, plus a same-origin check against BOUND_ORIGINS.
 *
 * Every refusal keeps the module's no-oracle rule (one neutral 400 for every
 * unusable token; the 410 only for a token that was real and is too late).
 */
export async function handleAccountDeleteUndo(
  env: Env,
  req: Request,
  deps: OAuthDeps,
  overrides?: BillingOverrides,
): Promise<Response> {
  const signInUrl = `${frontDoorOrigin(deps)}/`;
  const json = wantsJson(req);

  if (req.method === "GET") {
    const raw = new URL(req.url).searchParams.get("token");
    const resolved = await resolveUndoToken(env, deps, raw);
    if (json) {
      if (!resolved.ok) return deleteError(resolved.status, resolved.error, resolved.message);
      return jsonResponse({ restorable: true, undo_expires_at: resolved.expiresAt }, 200, NO_STORE);
    }
    if (!resolved.ok) return undoProblemPage(resolved, signInUrl);
    const vaults = await listVaultsForOwner(env.DB, resolved.user.id);
    const csrf = ensureCsrfToken(req);
    return htmlResponse(
      renderUndoConfirm({
        email: resolved.user.email,
        vaultNames: vaults.map((v) => v.name),
        deletedAt: resolved.user.deletedAt!,
        expiresAt: resolved.expiresAt,
        token: raw!,
        csrfToken: csrf.token,
        hasSubscription: resolved.user.stripeSubscriptionId !== null,
      }),
      200,
      { ...NO_STORE, ...(csrf.setCookie ? { "set-cookie": csrf.setCookie } : {}) },
    );
  }

  if (json) {
    const body = await readJsonBody(req);
    const outcome = await restoreAccount(env, deps, typeof body.token === "string" ? body.token : null, overrides);
    if (!outcome.ok) return deleteError(outcome.status, outcome.error, outcome.message);
    return jsonResponse(
      {
        restored: true,
        billing_resumed: outcome.billingResumed,
        ...(outcome.billingNote ? { billing_note: outcome.billingNote } : {}),
      },
      200,
      NO_STORE,
    );
  }

  // The page's form POST.
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return undoProblemPage(UNDO_INVALID, signInUrl);
  }
  if (!verifyCsrfToken(req, form) || !isSameOriginRequest(req, resolveBoundOrigins(deps))) {
    return htmlResponse(
      renderUndoProblem({
        title: "Please open the link again",
        message:
          "This page expired before the button was pressed, so nothing changed. Open the restore link from the email again and press the button once more.",
        signInUrl,
      }),
      403,
      NO_STORE,
    );
  }
  const token = form.get("token");
  const outcome = await restoreAccount(env, deps, typeof token === "string" ? token : null, overrides);
  if (!outcome.ok) return undoProblemPage(outcome, signInUrl);
  return htmlResponse(renderUndoDone({ signInUrl, billingResumed: outcome.billingResumed }), 200, NO_STORE);
}

function undoProblemPage(refusal: UndoRefusal, signInUrl: string): Response {
  if (refusal.error === "invalid_undo_token") {
    return htmlResponse(
      renderUndoProblem({
        title: "This restore link doesn't work",
        message:
          "It may have been used already, or copied only in part. If you already restored your account, just sign in. If more than 24 hours have passed since the deletion request, the account and its vaults have been erased.",
        signInUrl,
      }),
      400,
      NO_STORE,
    );
  }
  if (refusal.error === "undo_window_expired") {
    return htmlResponse(
      renderUndoProblem({
        title: "The restore window has closed",
        message:
          "The 24 hours to restore this account have passed, and its vaults and everything in them have been erased. You're welcome to start a new account any time.",
        signInUrl,
      }),
      410,
      NO_STORE,
    );
  }
  return htmlResponse(
    renderUndoProblem({ title: "Your account wasn't restored yet", message: refusal.message, signInUrl }),
    refusal.status,
    NO_STORE,
  );
}

// --- A-4: the convergence sweep ----------------------------------------------

/**
 * How many failed convergence passes an account may accumulate before the
 * sweep stops retrying quietly and pages the operator. At one pass per hour
 * this is two days — long enough that a transient DO or Stripe fault drains on
 * its own without waking anyone, short enough that the gap between what the
 * deletion email promised ("permanently deleted" after 24 hours) and what is
 * actually still on disk never quietly becomes a month.
 */
export const ACCOUNT_PURGE_ALERT_AFTER_ATTEMPTS = 48;

/**
 * Record one failed convergence pass and, past the threshold, page the
 * operator. Extracted so every `continue` in the sweep goes through the same
 * bookkeeping — an unrecorded deferral is exactly the invisible-forever case
 * this exists to prevent.
 *
 * WHY THIS NEEDS A HUMAN AND ISN'T JUST A RETRY. Billing tears down on the
 * FIRST pass and its converged marker is durable, so a permanently wedged
 * vault leaves an account that pays nothing, appears nowhere in the product,
 * and still holds tenant data the user was told in writing was destroyed a day
 * ago. Nothing about that state degrades further, and nothing about it
 * surfaces — the sweep would go on failing identically, forever, at the same
 * log level. The alert is the only thing that converts it into work.
 *
 * Best-effort throughout: neither the counter write nor the alert may throw
 * into the sweep loop, because the account after this one still needs its
 * pass.
 */
async function deferAccount(
  env: Env,
  sender: EmailSender | undefined,
  user: User,
  now: Date,
  reason: string,
): Promise<void> {
  const attempts = user.deletePurgeAttempts + 1;
  console.error(`event=account_purge_deferred user=${user.id} reason=${reason} attempts=${attempts}`);
  try {
    await env.DB
      .prepare("UPDATE users SET delete_purge_attempts = ? WHERE id = ?")
      .bind(attempts, user.id)
      .run();
  } catch (err) {
    console.error(
      `event=account_purge_attempt_write_failed user=${user.id} error=${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (attempts < ACCOUNT_PURGE_ALERT_AFTER_ATTEMPTS) return;

  const requestedAt = user.deletedAt ?? "unknown";
  await raiseOpsAlert(env, sender, {
    // Keyed per account: one wedged vault must not dedupe away another
    // account's alert. The hourly dedupe then applies per account.
    key: `account-purge:${user.id}`,
    subject: `account deletion stuck after ${attempts} passes`,
    text: [
      `An account past its 24-hour delete window has failed to converge for ${attempts} sweep passes.`,
      ``,
      `  account:      ${user.id}`,
      `  requested at: ${requestedAt}`,
      `  last reason:  ${reason}`,
      ``,
      `This account's billing is already torn down, so it is paying nothing and`,
      `is invisible in the product — but its data is STILL PRESENT, and the`,
      `deletion email told the user it would be permanently deleted 24 hours`,
      `after the request. That promise is currently unmet and will stay unmet`,
      `until someone acts.`,
      ``,
      `Most likely cause: a vault Durable Object that will not answer`,
      `POST /api/internal/destroy. Check the event=account_purge_vault_failed`,
      `lines for this account to see which vault and why.`,
      ``,
      `Alert repeats at most hourly per account while the condition persists.`,
    ].join("\n"),
    now,
  });
}

/**
 * Take the exclusive claim on an account before anything irreversible happens
 * to it — the atomic point the sweep and {@link handleAccountDeleteUndo} agree
 * on (migration 0025 carries the full argument for why a clock comparison
 * cannot be that point).
 *
 * `tombstone` is the `deleted_at` the sweep's cutoff SELECT read, and it is
 * bound, not merely tested for non-NULL. Three states fail the CAS, all three
 * correctly:
 *
 *   - the account was RESTORED after the SELECT (`deleted_at` is now NULL) —
 *     the undo won; do not touch it;
 *   - it was restored AND RE-DELETED inside this same pass (`deleted_at` is a
 *     different timestamp) — that is a NEW 24-hour window, and this pass
 *     selected the old one. Honor the new window; the next pass will pick it
 *     up when it actually expires. This is the case a bare `IS NOT NULL`
 *     re-check would get WRONG, and it is why the CAS binds the value;
 *   - the row is gone (a concurrent pass purged it).
 *
 * Idempotent across passes: the WHERE matches on the tombstone alone, so a
 * deferred account re-claims freely on its next pass. `COALESCE` keeps the
 * FIRST claim's timestamp, which is the forensically useful one — it dates the
 * moment the account stopped being restorable.
 *
 * Note this returns true on a re-claim even though no column value changes.
 * That is SQLite's `changes()` semantics — it counts rows the UPDATE matched,
 * not rows whose bytes moved — and the sweep depends on it, so it is pinned by
 * a test rather than left to belief.
 */
async function claimAccountForPurge(
  db: D1Database,
  userId: string,
  tombstone: string,
  now: Date,
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE users SET delete_purge_claimed_at = COALESCE(delete_purge_claimed_at, ?)
       WHERE id = ? AND deleted_at = ?`,
    )
    .bind(now.toISOString(), userId, tombstone)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export interface AccountDeleteSweepSummary {
  /** Accounts past their window that this pass looked at. */
  due: number;
  /** Accounts fully converged: billing gone, vaults erased, rows purged. */
  purged: number;
  /** Accounts left for the next pass because a step did not converge. */
  deferred: number;
  /**
   * Accounts that were due at SELECT time but whose claim lost the race — an
   * undo landed, or a re-delete opened a new window (cloud#248). Counted apart
   * from `deferred` on purpose: a deferral is a FAILURE to converge and feeds
   * the attempt counter that eventually pages an operator, whereas a skip is
   * the guard working exactly as designed and must never page anyone.
   */
  skipped: number;
  /** Accounts that threw — counted separately from an orderly deferral. */
  failed: number;
}

/**
 * Purge every identity row an account owns, ending with the account itself.
 * One D1 batch (D1's atomic unit — there are no interactive transactions), in
 * dependency order: the `owners` row resolves through `users.owner_id`, so it
 * must go before the row it reads.
 *
 * Releasing the `owners` row is deliberate, not incidental: a handle is a
 * global namespace claim, and leaving it held by a deleted account would
 * permanently burn the name.
 *
 * The vault-scoped tables (`vaults`, `vault_usage`, `vault_snapshots`) are
 * absent here on purpose — {@link deleteVaultD1Rows} already removed them
 * per-vault, gated on that vault's storage actually being destroyed. Dropping
 * them here too would let a vault whose DO destroy FAILED lose its ownership
 * row anyway, which is precisely how orphaned, still-billed storage is made.
 */
async function purgeAccountRows(
  db: D1Database,
  user: Pick<User, "id" | "email">,
  audit: D1PreparedStatement,
): Promise<void> {
  const userId = user.id;
  const email = user.email.trim().toLowerCase();
  await db.batch([
    db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM tokens WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM grants WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM auth_codes WHERE user_id = ?").bind(userId),
    // T-318: by EMAIL too. A sign-up link is minted before the account exists,
    // so it is stored with `user_id NULL` (auth-handlers.ts, magic-links.ts)
    // and a `user_id`-only delete left the address behind forever.
    db.prepare("DELETE FROM magic_links WHERE user_id = ? OR email = ?").bind(userId, email),
    db.prepare("DELETE FROM pending_logins WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM drip_sends WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM user_checklist WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM promo_redemptions WHERE user_id = ?").bind(userId),
    // T-318: operator alert dedupe rows whose key names this account
    // (`billing-hold-stuck:<id>`, `account-purge:<id>` — this module's own
    // keys). Matched on the exact `:<id>` SUFFIX with substr, not LIKE: D1
    // caps LIKE pattern length, and a UUID-bearing pattern exceeds it.
    db.prepare("DELETE FROM ops_alerts WHERE substr(key, -?) = ?").bind(userId.length + 1, `:${userId}`),
    db
      .prepare("DELETE FROM owners WHERE kind = 'user' AND owner_id = (SELECT owner_id FROM users WHERE id = ?)")
      .bind(userId),
    db.prepare("DELETE FROM users WHERE id = ?").bind(userId),
    // The record that this happened, in the same atomic batch as the erasure
    // it describes (account-audit.ts — hashed target, counts only).
    audit,
  ]);
}

/**
 * Converge every account whose 24-hour window has closed. Rides the hourly
 * tick (ops.ts) rather than claiming a cron pattern of its own — the window is
 * a day long, so hourly resolution is ample and a new pattern would have to be
 * added to two wrangler.toml `[triggers]` blocks to no benefit.
 *
 * Per account, in this order, stopping at the first step that does not
 * converge:
 *
 *   0. {@link claimAccountForPurge} — the CAS that makes this pass's verdict
 *      binding on the undo endpoint (cloud#248). Before it, everything is a
 *      read; after it, the account cannot be restored. A lost claim means an
 *      undo landed (or a re-delete opened a new window) between the SELECT and
 *      here, and the account is SKIPPED, not deferred.
 *   1. {@link teardownBilling} — money first. Its NULLed Stripe ids are the
 *      converged marker, so a retry after a partial pass costs nothing.
 *   2. Every owned vault: `callVaultDestroy` (the DO's SQLite and the whole
 *      `vault-<name>/` R2 prefix), then `deleteVaultD1Rows` — the SAME pair
 *      the single-vault delete door drives, in the same destroy-then-D1 order,
 *      so a failed destroy always leaves the ownership row behind to retry
 *      from. A vault that fails defers the WHOLE account: the user row must
 *      not be purged while a vault it owns still exists, because the row is
 *      the only thing that still says whose it was.
 *   3. {@link purgeAccountRows} — the account itself, last.
 *
 * Between passes the account stays tombstoned, which means A-1 keeps refusing
 * every read of it. So a deferral is never an exposure: it is a still-closed
 * account with residue behind it.
 *
 * PERMANENT DEFERRAL is the failure mode that actually needs handling, and it
 * does not look like a failure from inside the loop. Billing converges on the
 * FIRST pass and stays converged, so an account with one permanently wedged
 * vault settles into a steady state: paying nothing, absent from every product
 * surface, and still holding the data we told the user in writing would be
 * permanently deleted 24 hours after they asked. Nothing degrades, nothing
 * escalates, and every pass logs the same line. So each deferral increments
 * `users.delete_purge_attempts` (migration 0024) and past
 * {@link ACCOUNT_PURGE_ALERT_AFTER_ATTEMPTS} passes it pages the operator —
 * see {@link deferAccount}. The counter is the only reason this state is ever
 * seen by a human.
 *
 * Failure isolation is per account (the snapshot sweep's posture): one
 * account's Stripe outage or wedged DO must not stop the rest of the queue.
 */
export async function runAccountDeleteSweep(
  env: Env,
  deps: OAuthDeps,
  now: Date = new Date(),
  overrides?: BillingOverrides & { sender?: EmailSender; onlyUserId?: string },
): Promise<AccountDeleteSweepSummary> {
  const cutoff = new Date(now.getTime() - DELETE_UNDO_WINDOW_MS).toISOString();
  // `onlyUserId` scopes the pass to one account — the staging proof hook
  // (`/__test/account-delete/sweep`) uses it so a test run never purges
  // anyone else's expired account early. The cron never sets it.
  const only = overrides?.onlyUserId;
  const res = await env.DB
    .prepare(
      // `deleted_at` rides along because the claim below CASes on its exact
      // value (cloud#248) — the tombstone this pass decided was expired must
      // be the same one it destroys against. Fewest failed passes first: an
      // account this sweep keeps deferring must not hold a slot ahead of one
      // it has never tried, or a cap's worth of wedged accounts would block
      // every later deletion forever (and those never alert: 0 attempts).
      `SELECT id, deleted_at FROM users
       WHERE deleted_at IS NOT NULL AND deleted_at <= ?${only !== undefined ? " AND id = ?" : ""}
       ORDER BY delete_purge_attempts ASC, deleted_at ASC LIMIT ?`,
    )
    .bind(...(only !== undefined ? [cutoff, only] : [cutoff]), ACCOUNT_DELETE_SWEEP_CAP)
    .all<{ id: string; deleted_at: string }>();
  const due = res.results ?? [];
  const summary: AccountDeleteSweepSummary = { due: due.length, purged: 0, deferred: 0, skipped: 0, failed: 0 };

  for (const { id: userId, deleted_at: tombstone } of due) {
    try {
      const user = await getUserById(env.DB, userId);
      if (!user) continue; // Raced with another pass — already gone.

      // 0. THE CLAIM — before billing, before storage, before anything this
      //    module cannot take back. Everything below is irreversible or
      //    irreversible-adjacent, and everything above is a read; this is the
      //    line between them, and it is one conditional UPDATE wide.
      //
      //    A failed claim is NOT a deferral: nothing went wrong, and routing
      //    it through deferAccount would increment the attempt counter and
      //    eventually page an operator about a race the guard just won.
      if (!(await claimAccountForPurge(env.DB, userId, tombstone, now))) {
        summary.skipped++;
        console.log(`event=account_purge_skipped_unclaimed user=${userId} tombstone=${tombstone}`);
        continue;
      }

      // 1. Billing. What Stripe held is recorded on the audit row at purge
      //    (T-318) — after this account's row is gone, that row is the only
      //    place that can say whether a Stripe customer existed and went.
      const hadStripeCustomer = user.stripeCustomerId !== null;
      const hadStripeSubscription = user.stripeSubscriptionId !== null;
      if (hasBillingArtifacts(user)) {
        const stripe = stripeFor(env, overrides);
        if (!stripe) {
          await deferAccount(env, overrides?.sender, user, now, "billing_not_configured");
          summary.deferred++;
          continue;
        }
        const billing = await teardownBilling(stripe, env.DB, userId);
        if (!billing.converged) {
          await deferAccount(env, overrides?.sender, user, now, `billing:${billing.error}`);
          summary.deferred++;
          continue;
        }
      }

      // 2. Vault storage — the only step that erases tenant content.
      //
      // The destroy REPLY is validated, not just its status, through the same
      // `readDestroyOutcome` the single-vault door uses (vault-call.ts). This
      // is not defensive padding: the very next statement deletes the D1 rows
      // that are the only remaining record of whose bytes those were, so a 200
      // that isn't the DO's real answer would orphan the storage permanently —
      // still billed, no longer attributable, and beyond the reach of any
      // retry, because nothing left in the system would know to try.
      let storageConverged = true;
      let vaultsDestroyed = 0;
      let r2ObjectsDeleted = 0;
      for (const vault of await listVaultsForOwner(env.DB, userId)) {
        let outcome: Awaited<ReturnType<typeof readDestroyOutcome>>;
        try {
          outcome = await readDestroyOutcome(await callVaultDestroy(env.DB, deps, userId, vault.name));
        } catch (err) {
          outcome = { ok: false, reason: "transport", detail: err instanceof Error ? err.message : String(err) };
        }
        if (!outcome.ok) {
          console.error(
            `event=account_purge_vault_failed user=${userId} vault=${vault.name} reason=${outcome.reason} detail=${JSON.stringify(outcome.detail)}`,
          );
          storageConverged = false;
          continue;
        }
        await deleteVaultD1Rows(env.DB, userId, vault.name, now);
        vaultsDestroyed++;
        r2ObjectsDeleted += outcome.r2ObjectsDeleted;
      }
      if (!storageConverged) {
        await deferAccount(env, overrides?.sender, user, now, "vault_storage");
        summary.deferred++;
        continue;
      }

      // 3. The account. Vault counts here are THIS pass's; a deferred earlier
      //    pass may already have destroyed some (their D1 rows went with them).
      const audit = await auditStatement(env.DB, {
        actor: "sweep",
        action: "purged",
        userId,
        note: {
          stripe_customer_before: hadStripeCustomer,
          stripe_subscription_before: hadStripeSubscription,
          // Reaching this line means teardownBilling converged (or there was
          // nothing to tear down): the customer was deleted in Stripe.
          stripe_customer_deleted: hadStripeCustomer,
          vaults_destroyed: vaultsDestroyed,
          r2_objects_deleted: r2ObjectsDeleted,
        },
        now,
      });
      await purgeAccountRows(env.DB, user, audit);
      summary.purged++;
      console.log(
        `event=account_purged user=${userId} vaults_destroyed=${vaultsDestroyed} r2_objects_deleted=${r2ObjectsDeleted} stripe_customer_deleted=${hadStripeCustomer}`,
      );
    } catch (err) {
      console.error(
        `event=account_purge_failed user=${userId} error=${err instanceof Error ? err.message : String(err)}`,
      );
      summary.failed++;
    }
  }

  console.log(
    `event=account_delete_sweep due=${summary.due} purged=${summary.purged} deferred=${summary.deferred} skipped=${summary.skipped} failed=${summary.failed}`,
  );
  return summary;
}
