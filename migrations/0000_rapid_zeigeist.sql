CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`stripe_customer_id` text,
	`fly_app_name` text,
	`fly_machine_id` text,
	`tier` text DEFAULT 'starter' NOT NULL,
	`status` text DEFAULT 'pending_provision' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `provisioning_secrets` (
	`tenant_id` text PRIMARY KEY NOT NULL,
	`secret` text NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
