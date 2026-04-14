/**
 * D1 accounts database schema.
 *
 * This is the ONLY cross-tenant store. Per-vault data (notes, tags, links,
 * attachments) lives inside each vault's Durable Object — never here.
 *
 * Tables:
 *   - users            Clerk user ↔ internal user ID.
 *   - vaults           vault_id, owner user, subdomain, tier, timestamps.
 *   - subscriptions    Stripe customer + subscription state per user.
 *   - custom_hostnames subdomain / vanity hostname records (CF Custom Hostnames).
 *
 * TODO (scaffold only): define these with drizzle-orm/sqlite and generate
 * migrations via drizzle-kit. Example shape below, not yet wired to drizzle.
 */

// import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

// export const users = sqliteTable("users", {
//   id: text("id").primaryKey(),                  // internal UUID
//   clerkUserId: text("clerk_user_id").notNull().unique(),
//   email: text("email").notNull(),
//   createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
// });

// export const vaults = sqliteTable("vaults", {
//   id: text("id").primaryKey(),                  // vault UUID, used as DO name
//   userId: text("user_id").notNull().references(() => users.id),
//   subdomain: text("subdomain").notNull().unique(),
//   tier: text("tier").notNull().default("free"),
//   createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
//   deletedAt: integer("deleted_at", { mode: "timestamp" }),
// });

// export const subscriptions = sqliteTable("subscriptions", {
//   userId: text("user_id").primaryKey().references(() => users.id),
//   stripeCustomerId: text("stripe_customer_id").notNull(),
//   stripeSubscriptionId: text("stripe_subscription_id"),
//   tier: text("tier").notNull().default("free"),
//   status: text("status").notNull(),             // active | past_due | canceled | ...
//   currentPeriodEnd: integer("current_period_end", { mode: "timestamp" }),
// });

// export const customHostnames = sqliteTable("custom_hostnames", {
//   id: text("id").primaryKey(),                  // CF custom hostname record ID
//   vaultId: text("vault_id").notNull().references(() => vaults.id),
//   hostname: text("hostname").notNull().unique(),
//   status: text("status").notNull(),             // pending | active | failed
//   createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
// });
