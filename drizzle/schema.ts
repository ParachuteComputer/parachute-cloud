/**
 * D1 accounts database schema.
 *
 * The ONLY cross-tenant store. Per-vault data lives inside each vault's
 * Durable Object — never here.
 */

import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  clerkUserId: text("clerk_user_id").notNull().unique(),
  email: text("email").notNull(),
  tier: text("tier").notNull().default("free"),
  createdAt: integer("created_at").notNull(),
});

export const vaults = sqliteTable(
  "vaults",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    hostname: text("hostname").notNull().unique(),
    createdAt: integer("created_at").notNull(),
    deletedAt: integer("deleted_at"),
  },
  (t) => ({
    ownerIdx: index("vaults_owner_idx").on(t.ownerUserId),
  }),
);

export const hostnames = sqliteTable("hostnames", {
  hostname: text("hostname").primaryKey(),
  vaultId: text("vault_id")
    .notNull()
    .references(() => vaults.id),
  cfCustomHostnameId: text("cf_custom_hostname_id"),
  status: text("status").notNull().default("pending"),
});

export const subscriptions = sqliteTable(
  "subscriptions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    stripeCustomerId: text("stripe_customer_id").notNull().unique(),
    stripeSubscriptionId: text("stripe_subscription_id"),
    status: text("status").notNull(),
    tier: text("tier").notNull(),
    currentPeriodEnd: integer("current_period_end"),
  },
  (t) => ({
    userIdx: index("subs_user_idx").on(t.userId),
  }),
);

export const usageEvents = sqliteTable(
  "usage_events",
  {
    id: text("id").primaryKey(),
    vaultId: text("vault_id")
      .notNull()
      .references(() => vaults.id),
    kind: text("kind").notNull(),
    count: integer("count").notNull().default(1),
    occurredAt: integer("occurred_at").notNull(),
  },
  (t) => ({
    vaultIdx: index("usage_vault_idx").on(t.vaultId, t.occurredAt),
  }),
);

export type User = typeof users.$inferSelect;
export type Vault = typeof vaults.$inferSelect;
export type Hostname = typeof hostnames.$inferSelect;
export type Subscription = typeof subscriptions.$inferSelect;
