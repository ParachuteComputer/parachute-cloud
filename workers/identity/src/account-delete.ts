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
 *     magic-link request/consume, the drip, and the billing/usage/snapshot
 *     sweeps. THIS MODULE IS THE FIRST THING THAT WRITES THAT COLUMN. Because
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
 * NO ORACLE, same posture as the vault door: an invalid, unknown, or expired
 * undo token gets one neutral answer. The undo endpoint is the ONE account
 * surface that must work for a user whose auth was just severed, so it
 * authenticates on the mailed token alone — never a session, never a bearer,
 * both of which A-1 now refuses by construction.
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
import { makeStripe } from "./stripe-client.ts";
import { type User, getUserById } from "./users.ts";
import { callVaultDestroy } from "./vault-call.ts";
import { deleteVaultD1Rows, listVaultsForOwner } from "./vaults.ts";

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
 *   3. Auth severance — sessions dropped, live tokens revoked. Belt, not
 *      braces: A-1's chokepoints already refuse a tombstoned account at every
 *      read path, so the account is dead the instant step 2 commits whether or
 *      not this succeeds. It runs anyway so the rows don't sit there
 *      spendable-looking for a day, and a failure is logged, not fatal —
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
  const confirm = typeof body.confirm === "string" ? body.confirm.trim().toLowerCase() : null;
  if (confirm === null || confirm !== user.email.trim().toLowerCase()) {
    return deleteError(
      400,
      "confirm_mismatch",
      `deleting an account requires the body {"confirm": "${user.email}"}`,
    );
  }

  // 1. The reversible hold, before anything durable.
  const stripe = stripeFor(env, overrides);
  if (user.stripeSubscriptionId !== null) {
    if (!stripe) {
      return deleteError(
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
      return deleteError(
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
      .prepare("UPDATE users SET deleted_at = ?, delete_undo_hash = ? WHERE id = ? AND deleted_at IS NULL")
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
        console.error(
          `event=account_delete_hold_not_released user=${user.id} error=${resumeErr instanceof Error ? resumeErr.message : String(resumeErr)}`,
        );
      }
    }
    return deleteError(
      500,
      "delete_request_failed",
      "The deletion could not be recorded. Nothing was deleted; retry the request.",
    );
  }
  if (changed === 0) {
    // requireAccount already refuses a tombstoned account, so reaching here
    // means a concurrent request won the race — report it rather than minting
    // a second undo token that would silently orphan the first.
    return deleteError(409, "already_deleting", "This account is already scheduled for deletion.");
  }

  // 3. Sever the credentials that exist right now (belt — see the doc above).
  try {
    await deleteSessionsForUser(env.DB, user.id);
    await env.DB
      .prepare("UPDATE tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
      .bind(nowIso, user.id)
      .run();
  } catch (err) {
    console.error(
      `event=account_delete_severance_incomplete user=${user.id} error=${err instanceof Error ? err.message : String(err)}`,
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
        `You have until ${purgeAt.toISOString()} (24 hours) to change your mind.`,
        `After that, your vaults and their contents are permanently deleted and`,
        `cannot be recovered.`,
        ``,
        `To restore your account, open this link before then:`,
        `${undoUrl}`,
        ``,
        `If you did not request this, restore your account now and change your`,
        `password.`,
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

  console.log(`event=account_delete_requested user=${user.id} purge_at=${purgeAt.toISOString()} notice_sent=${noticeSent}`);
  return jsonResponse(
    {
      deleted: true,
      deleted_at: nowIso,
      undo_expires_at: purgeAt.toISOString(),
      undo_token: undoToken,
      undo_url: undoUrl,
      notice_sent: noticeSent,
    },
    200,
    { "cache-control": "no-store" },
  );
}

// --- A-3b: /account/undo-delete — the way back, inside the window ------------

/** The one neutral answer for every unusable token — see the module note. */
function invalidUndoToken(): Response {
  return deleteError(400, "invalid_undo_token", "That restore link is not valid.");
}

/**
 * Restore an account inside its undo window. Authenticated by the mailed token
 * ALONE — no session, no bearer — because A-1 refuses both for a tombstoned
 * account, so any other credential would make undo structurally impossible.
 *
 * Answers both GET (`?token=` — the link in the notice email, so a click
 * restores) and POST (`{ "token": ... }` — API clients). A GET that mutates is
 * a deliberate exception, on the same footing as the magic-link consume: the
 * token is single-use and unguessable, and the mutation is the RESTORING
 * direction, so a stray prefetch can only ever un-delete something the account
 * holder asked to be able to un-delete.
 *
 * Order mirrors the request path in reverse, and again the reversible thing
 * leads: billing is resumed BEFORE the tombstone clears, so an account that
 * comes back always comes back with its subscription state already settled.
 * A hard Stripe failure leaves the tombstone in place and the window still
 * open — retryable, and the account stays honestly deleted meanwhile rather
 * than half-restored.
 *
 * The one case that cannot be undone is reported, not hidden: if the billing
 * period boundary passed during the window, Stripe already canceled for real
 * and there is no un-cancel ({@link resumeBilling}'s `already_canceled`). The
 * account still restores — the user's data is theirs regardless — but the
 * response says billing did not come back, so a caller can say so plainly
 * instead of leaving them to discover it on a failed feature.
 *
 * Sessions are NOT restored (they were deleted, not tombstoned): a restored
 * user signs in again. That is the safe direction and it costs one magic link.
 */
export async function handleAccountDeleteUndo(
  env: Env,
  req: Request,
  deps: OAuthDeps,
  overrides?: BillingOverrides,
): Promise<Response> {
  let raw: string | null = null;
  if (req.method === "GET") {
    raw = new URL(req.url).searchParams.get("token");
  } else {
    const body = await readJsonBody(req);
    raw = typeof body.token === "string" ? body.token : null;
  }
  if (!raw) return invalidUndoToken();

  const hash = await sha256Hex(raw);
  const row = await env.DB
    .prepare("SELECT id FROM users WHERE delete_undo_hash = ?")
    .bind(hash)
    .first<{ id: string }>();
  if (!row) return invalidUndoToken();
  const user = await getUserById(env.DB, row.id);
  if (!user || user.deletedAt === null) return invalidUndoToken();

  const now = deps.now?.() ?? new Date();
  const requestedAtMs = Date.parse(user.deletedAt);
  // An unparseable timestamp is corruption, not an open window — refuse to
  // treat it as restorable rather than guessing which side of the line it's on.
  if (!Number.isFinite(requestedAtMs) || now.getTime() - requestedAtMs >= DELETE_UNDO_WINDOW_MS) {
    return deleteError(
      410,
      "undo_window_expired",
      "The 24-hour window to restore this account has passed and its data has been deleted.",
    );
  }

  const stripe = stripeFor(env, overrides);
  let billingResumed = true;
  let billingNote: "already_canceled" | null = null;
  if (user.stripeSubscriptionId !== null) {
    if (!stripe) {
      return deleteError(
        503,
        "billing_not_configured",
        "Billing is not configured here, so this account's subscription cannot be resumed. The account was not restored; retry later.",
      );
    }
    try {
      const result = await resumeBilling(stripe, user.stripeSubscriptionId);
      if (!result.resumed) {
        billingResumed = false;
        billingNote = result.reason;
      }
    } catch (err) {
      console.error(
        `event=account_undo_billing_failed user=${user.id} error=${err instanceof Error ? err.message : String(err)}`,
      );
      return deleteError(
        502,
        "billing_resume_failed",
        "Billing could not be resumed, so the account was not restored. Nothing changed; retry the request.",
      );
    }
  }

  const res = await env.DB
    .prepare(
      "UPDATE users SET deleted_at = NULL, delete_undo_hash = NULL, delete_notice_sent_at = NULL WHERE id = ? AND deleted_at IS NOT NULL",
    )
    .bind(user.id)
    .run();
  // Zero rows means the sweep or a concurrent undo got here first — the token
  // is spent either way, and it is now indistinguishable from any other dead
  // token, which is exactly the answer it should get.
  if ((res.meta.changes ?? 0) === 0) return invalidUndoToken();

  console.log(`event=account_delete_undone user=${user.id} billing_resumed=${billingResumed}`);
  return jsonResponse(
    {
      restored: true,
      billing_resumed: billingResumed,
      ...(billingNote ? { billing_note: billingNote } : {}),
    },
    200,
    { "cache-control": "no-store" },
  );
}

// --- A-4: the convergence sweep ----------------------------------------------

export interface AccountDeleteSweepSummary {
  /** Accounts past their window that this pass looked at. */
  due: number;
  /** Accounts fully converged: billing gone, vaults erased, rows purged. */
  purged: number;
  /** Accounts left for the next pass because a step did not converge. */
  deferred: number;
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
async function purgeAccountRows(db: D1Database, userId: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM tokens WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM grants WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM auth_codes WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM magic_links WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM pending_logins WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM drip_sends WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM user_checklist WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM promo_redemptions WHERE user_id = ?").bind(userId),
    db
      .prepare("DELETE FROM owners WHERE kind = 'user' AND owner_id = (SELECT owner_id FROM users WHERE id = ?)")
      .bind(userId),
    db.prepare("DELETE FROM users WHERE id = ?").bind(userId),
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
 * Failure isolation is per account (the snapshot sweep's posture): one
 * account's Stripe outage or wedged DO must not stop the rest of the queue.
 */
export async function runAccountDeleteSweep(
  env: Env,
  deps: OAuthDeps,
  now: Date = new Date(),
  overrides?: BillingOverrides,
): Promise<AccountDeleteSweepSummary> {
  const cutoff = new Date(now.getTime() - DELETE_UNDO_WINDOW_MS).toISOString();
  const res = await env.DB
    .prepare(
      `SELECT id FROM users
       WHERE deleted_at IS NOT NULL AND deleted_at <= ?
       ORDER BY deleted_at ASC LIMIT ?`,
    )
    .bind(cutoff, ACCOUNT_DELETE_SWEEP_CAP)
    .all<{ id: string }>();
  const due = res.results ?? [];
  const summary: AccountDeleteSweepSummary = { due: due.length, purged: 0, deferred: 0, failed: 0 };

  for (const { id: userId } of due) {
    try {
      const user = await getUserById(env.DB, userId);
      if (!user) continue; // Raced with another pass — already gone.

      // 1. Billing.
      if (hasBillingArtifacts(user)) {
        const stripe = stripeFor(env, overrides);
        if (!stripe) {
          console.error(`event=account_purge_deferred user=${userId} reason=billing_not_configured`);
          summary.deferred++;
          continue;
        }
        const billing = await teardownBilling(stripe, env.DB, userId);
        if (!billing.converged) {
          console.error(`event=account_purge_deferred user=${userId} reason=billing error=${billing.error}`);
          summary.deferred++;
          continue;
        }
      }

      // 2. Vault storage — the only step that erases tenant content.
      let storageConverged = true;
      for (const vault of await listVaultsForOwner(env.DB, userId)) {
        try {
          const destroyed = await callVaultDestroy(env.DB, deps, userId, vault.name);
          if (!destroyed.ok) {
            console.error(
              `event=account_purge_vault_failed user=${userId} vault=${vault.name} status=${destroyed.status}`,
            );
            storageConverged = false;
            continue;
          }
        } catch (err) {
          console.error(
            `event=account_purge_vault_failed user=${userId} vault=${vault.name} error=${err instanceof Error ? err.message : String(err)}`,
          );
          storageConverged = false;
          continue;
        }
        await deleteVaultD1Rows(env.DB, userId, vault.name, now);
      }
      if (!storageConverged) {
        console.error(`event=account_purge_deferred user=${userId} reason=vault_storage`);
        summary.deferred++;
        continue;
      }

      // 3. The account.
      await purgeAccountRows(env.DB, userId);
      summary.purged++;
      console.log(`event=account_purged user=${userId}`);
    } catch (err) {
      console.error(
        `event=account_purge_failed user=${userId} error=${err instanceof Error ? err.message : String(err)}`,
      );
      summary.failed++;
    }
  }

  console.log(
    `event=account_delete_sweep due=${summary.due} purged=${summary.purged} deferred=${summary.deferred} failed=${summary.failed}`,
  );
  return summary;
}
