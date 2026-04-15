/**
 * D1 accounts database schema — v0.4 user-per-subdomain.
 *
 * The ONLY cross-tenant store. Per-vault note/attachment data lives inside
 * each vault's Durable Object — never here.
 */

import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    clerkUserId: text("clerk_user_id").notNull().unique(),
    email: text("email").notNull(),
    // Null until the user picks one at onboarding. One hostname per user.
    hostname: text("hostname").unique(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({
    hostnameIdx: index("users_hostname_idx").on(t.hostname),
  }),
);

export const hostnames = sqliteTable("hostnames", {
  hostname: text("hostname").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  cfCustomHostnameId: text("cf_custom_hostname_id"),
  status: text("status").notNull().default("pending"),
  createdAt: integer("created_at").notNull(),
});

export const vaults = sqliteTable(
  "vaults",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    createdAt: integer("created_at").notNull(),
    deletedAt: integer("deleted_at"),
  },
  (t) => ({
    userIdx: index("vaults_user_idx").on(t.userId),
    userSlug: uniqueIndex("vaults_user_slug_uk").on(t.userId, t.slug),
  }),
);

export const tokens = sqliteTable(
  "tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    // Null = user-scope (access all user's vaults).
    vaultSlug: text("vault_slug"),
    tokenHash: text("token_hash").notNull().unique(),
    name: text("name").notNull(),
    createdAt: integer("created_at").notNull(),
    lastUsedAt: integer("last_used_at"),
    revokedAt: integer("revoked_at"),
  },
  (t) => ({
    userIdx: index("tokens_user_idx").on(t.userId),
    hashIdx: index("tokens_hash_idx").on(t.tokenHash),
  }),
);

export const subscriptions = sqliteTable(
  "subscriptions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
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
    vaultId: text("vault_id").notNull().references(() => vaults.id),
    kind: text("kind").notNull(),
    count: integer("count").notNull().default(1),
    occurredAt: integer("occurred_at").notNull(),
  },
  (t) => ({
    vaultIdx: index("usage_vault_idx").on(t.vaultId, t.occurredAt),
  }),
);

export type User = typeof users.$inferSelect;
export type Hostname = typeof hostnames.$inferSelect;
export type Vault = typeof vaults.$inferSelect;
export type Token = typeof tokens.$inferSelect;
export type Subscription = typeof subscriptions.$inferSelect;
