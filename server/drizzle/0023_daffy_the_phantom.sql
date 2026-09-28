CREATE TABLE `instance_grants` (
	`user_id` text NOT NULL,
	`instance_id` text NOT NULL,
	`granted_by` text,
	`created_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `instance_id`)
);
--> statement-breakpoint
CREATE TABLE `role_permissions` (
	`role_id` text NOT NULL,
	`permission` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`role_id`, `permission`)
);
--> statement-breakpoint
CREATE TABLE `roles` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`kind` text DEFAULT 'user' NOT NULL,
	`is_builtin` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `user_roles` (
	`user_id` text PRIMARY KEY NOT NULL,
	`role_id` text NOT NULL,
	`created_at` text NOT NULL
);
