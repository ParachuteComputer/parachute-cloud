/**
 * D1 schema for the parachute-cloud control plane.
 *
 * Tables:
 *   - accounts: one row per tenant. Holds the metadata the control plane
 *     needs to operate the user's Fly Machine (which app, which machine,
 *     which tier, what state). NEVER holds user-data-shaped fields — all
 *     of that lives on the user's Fly volume, not here.
 *   - provisioning_secrets: short-lived per-tenant tokens used by the VM's
 *     bootstrap to call back into POST /api/internal/provision-complete.
 *     Single-use — the row is deleted when the callback succeeds.
 *   - processed_stripe_events: event-id dedup for the Stripe webhook
 *     (cloud#13). The webhook handler does an `INSERT OR IGNORE` keyed on
 *     `event.id` before mutating tenant state, so two concurrent deliveries
 *     of the same event can't both pass. Phase 3 introduced this as Stripe
 *     fan-out widened beyond the single `checkout.session.completed`.
 *
 * IDs are UUIDv4 strings. At our expected scale (handful-to-thousands of
 * tenants) the time-ordered scan ULID buys us is irrelevant; UUIDv4 keeps
 * the schema dialect-portable if we ever swap providers.
 *
 * Stripe Phase 2: checkout + completion webhook populate `stripe_customer_id`
 * and `stripe_subscription_id` when `checkout.session.completed` fires.
 * Phase 3-(a) widens the webhook surface to subscription-lifecycle events
 * (`invoice.paid`, `invoice.payment_failed`, `customer.subscription.deleted`,
 * `customer.subscription.updated`) — those drive the columns added below
 * (`last_invoice_paid_at`, `payment_failed_at`/`_count`, `terminating_at`,
 * `pending_tier`) and the `terminating` lifecycle state.
 */

import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Lifecycle states for a tenant's VM. Transitions:
 *   pending_provision → provisioning → active
 *                                   ↘ failed (terminal until manual retry)
 *   active → terminating → terminated → (deleted | reactivated)
 *     - terminating set by `customer.subscription.deleted` webhook
 *     - reconciler waits TERMINATION_GRACE_PERIOD_MS, then destroys VM
 *       and flips status → terminated; row retained TERMINATED_RETENTION_MS
 *       so a re-subscribe can re-provision
 *     - GC pass deletes terminated rows past retention
 *   active → suspended → active                (reserved; not used in 3 —
 *                                                payment_failed only flags,
 *                                                doesn't suspend)
 */
export type AccountStatus =
  | "pending_provision"
  | "provisioning"
  | "active"
  | "failed"
  | "terminating"
  | "terminated"
  | "suspended"
  | "deleted";

export const accounts = sqliteTable("accounts", {
  /** UUIDv4. Generated control-plane-side at signup. */
  id: text("id").primaryKey(),
  /** Customer email — sourced from Stripe Checkout. */
  email: text("email").notNull(),
  /** Stripe customer id — set when `checkout.session.completed` fires. */
  stripeCustomerId: text("stripe_customer_id"),
  /** Stripe subscription id from the same checkout session. */
  stripeSubscriptionId: text("stripe_subscription_id"),
  /** Fly app name (`parachute-<slug>`). Set when provisioning starts. */
  flyAppName: text("fly_app_name"),
  /** Fly machine id within the app. Set when provisioning starts. */
  flyMachineId: text("fly_machine_id"),
  /** Tier — see src/billing/tiers.ts. Defaults to "starter" until Phase 3. */
  tier: text("tier").notNull().default("starter"),
  /**
   * Tier the user has scheduled to switch to at the next renewal. Set when
   * `customer.subscription.updated` arrives with a `pending` change (Stripe's
   * proration_behavior=none flow); cleared once we observe the renewal land
   * on the new price. Null = no pending change.
   */
  pendingTier: text("pending_tier"),
  /** Lifecycle state — see AccountStatus above. */
  status: text("status").$type<AccountStatus>().notNull().default("pending_provision"),
  /** ISO 8601 timestamp of last successful `invoice.paid`. Null until first renewal. */
  lastInvoicePaidAt: text("last_invoice_paid_at"),
  /**
   * ISO 8601 timestamp of the most recent `invoice.payment_failed`.
   * Cleared on the next successful invoice.paid. Surface-only in Phase 3-(a)
   * — dashboard renders a dunning banner; we do NOT auto-suspend.
   */
  paymentFailedAt: text("payment_failed_at"),
  /**
   * Count of consecutive failed-payment events since the last success.
   * Reset to 0 on invoice.paid. Useful for "how loud should the banner be".
   */
  paymentFailedCount: integer("payment_failed_count").notNull().default(0),
  /**
   * ISO 8601 timestamp set when `customer.subscription.deleted` fires.
   * Phase 3-(b)'s reconciler waits TERMINATION_GRACE_PERIOD past this
   * before destroying the Fly machine and flipping status → `terminated`.
   */
  terminatingAt: text("terminating_at"),
  /**
   * ISO 8601 timestamp set when Phase 3-(b)'s reconciler successfully
   * destroys the Fly machine. Row is retained TERMINATED_RETENTION_MS
   * past this so a re-subscribe in that window can re-provision.
   */
  terminatedAt: text("terminated_at"),
  /**
   * Count of consecutive failed reconcile attempts on a `pendingTier`
   * change. Reset to 0 on success. Caps at TIER_CHANGE_MAX_RETRIES; once
   * the cap is hit, `tierChangeBlockedError` is set and the reconciler
   * stops retrying until an operator clears the field. Surfaces on the
   * dashboard as `tier_change_blocked` so the row is visible.
   */
  tierChangeRetries: integer("tier_change_retries").notNull().default(0),
  /**
   * Last error message from a failed tier-change reconcile attempt, or
   * null when the row is healthy / has never failed. Cleared on success.
   * Bounded length (sliced upstream) so a chatty provider error can't
   * blow up D1 row size — see reconcileTierChanges.
   */
  tierChangeBlockedError: text("tier_change_blocked_error"),
  /** ISO 8601 timestamp of row creation. */
  createdAt: text("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

export const provisioningSecrets = sqliteTable("provisioning_secrets", {
  /** Foreign key to accounts.id. Single secret per tenant at a time. */
  tenantId: text("tenant_id")
    .primaryKey()
    .references(() => accounts.id, { onDelete: "cascade" }),
  /** Random 32-byte hex string. Compared in constant time on callback. */
  secret: text("secret").notNull(),
  /** ISO 8601 timestamp; rows past this are rejected on callback and swept. */
  expiresAt: text("expires_at").notNull(),
});

/**
 * Stripe webhook event-id dedup (cloud#13).
 *
 * The handler does `INSERT OR IGNORE` on `event_id` before mutating tenant
 * state. A unique-violation on the second concurrent delivery means that
 * delivery short-circuits before doing any mutation. Without this, two
 * concurrent webhook deliveries can both pass the row-status idempotency
 * guard and double-orchestrate.
 *
 * Retention: rows accumulate forever for now. At Stripe's event volume
 * for our scale (one per tenant lifecycle moment), even a few years of
 * rows fits comfortably. A future cron can sweep rows older than e.g. 30
 * days — Stripe doesn't retry past 3.
 */
export const processedStripeEvents = sqliteTable("processed_stripe_events", {
  /** Stripe `event.id` (e.g. `evt_1NxYz...`). Primary key for dedup. */
  eventId: text("event_id").primaryKey(),
  /** ISO 8601 timestamp the event was first observed and acted on. */
  processedAt: text("processed_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
export type ProvisioningSecret = typeof provisioningSecrets.$inferSelect;
export type NewProvisioningSecret = typeof provisioningSecrets.$inferInsert;
export type ProcessedStripeEvent = typeof processedStripeEvents.$inferSelect;
export type NewProcessedStripeEvent = typeof processedStripeEvents.$inferInsert;
