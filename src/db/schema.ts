/**
 * D1 schema for the parachute-cloud control plane.
 *
 * Two tables for now (Phase 2 scope):
 *   - accounts: one row per tenant. Holds the metadata the control plane
 *     needs to operate the user's Fly Machine (which app, which machine,
 *     which tier, what state). NEVER holds user-data-shaped fields — all
 *     of that lives on the user's Fly volume, not here.
 *   - provisioning_secrets: short-lived per-tenant tokens used by the VM's
 *     bootstrap to call back into POST /api/internal/provision-complete.
 *     Single-use — the row is deleted when the callback succeeds.
 *
 * IDs are UUIDv4 strings. At our expected scale (handful-to-thousands of
 * tenants) the time-ordered scan ULID buys us is irrelevant; UUIDv4 keeps
 * the schema dialect-portable if we ever swap providers.
 *
 * Stripe-billing wiring (price IDs, subscription state, invoice history)
 * lands in Phase 3 — the `stripe_customer_id` column is the only forward
 * hook this Phase 2 schema cuts.
 */

import { sql } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Lifecycle states for a tenant's VM. Transitions:
 *   pending_provision → provisioning → active
 *                                   ↘ failed (terminal until manual retry)
 *   active → suspended → active                (Phase 3, billing-driven)
 *   active → deleted                           (Phase 3, billing-driven)
 */
export type AccountStatus =
  | "pending_provision"
  | "provisioning"
  | "active"
  | "failed"
  | "suspended"
  | "deleted";

export const accounts = sqliteTable("accounts", {
  /** UUIDv4. Generated control-plane-side at signup. */
  id: text("id").primaryKey(),
  /** Customer email — sourced from Stripe Checkout. */
  email: text("email").notNull(),
  /** Stripe customer id — set when checkout completes (Phase 2 → Phase 3 hook). */
  stripeCustomerId: text("stripe_customer_id"),
  /** Fly app name (`parachute-<slug>`). Set when provisioning starts. */
  flyAppName: text("fly_app_name"),
  /** Fly machine id within the app. Set when provisioning starts. */
  flyMachineId: text("fly_machine_id"),
  /** Tier — see src/billing/tiers.ts. Defaults to "starter" until Phase 3. */
  tier: text("tier").notNull().default("starter"),
  /** Lifecycle state — see AccountStatus above. */
  status: text("status").$type<AccountStatus>().notNull().default("pending_provision"),
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

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
export type ProvisioningSecret = typeof provisioningSecrets.$inferSelect;
export type NewProvisioningSecret = typeof provisioningSecrets.$inferInsert;
