CREATE TABLE `processed_stripe_events` (
	`event_id` text PRIMARY KEY NOT NULL,
	`processed_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `accounts` ADD `pending_tier` text;--> statement-breakpoint
ALTER TABLE `accounts` ADD `last_invoice_paid_at` text;--> statement-breakpoint
ALTER TABLE `accounts` ADD `payment_failed_at` text;--> statement-breakpoint
ALTER TABLE `accounts` ADD `payment_failed_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `accounts` ADD `terminating_at` text;