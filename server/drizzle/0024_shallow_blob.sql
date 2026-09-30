ALTER TABLE `instance_mods` ADD `retry_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `instance_mods` ADD `next_retry_at` text;