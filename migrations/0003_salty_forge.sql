ALTER TABLE `accounts` ADD `terminated_at` text;--> statement-breakpoint
ALTER TABLE `accounts` ADD `tier_change_retries` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `accounts` ADD `tier_change_blocked_error` text;