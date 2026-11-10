CREATE TABLE "login_throttles" (
	"key_hash" text PRIMARY KEY NOT NULL,
	"failure_count" integer NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"locked_until" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "login_throttles_failure_count_positive" CHECK ("login_throttles"."failure_count" > 0),
	CONSTRAINT "login_throttles_key_hash_format" CHECK ("login_throttles"."key_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_category_valid";--> statement-breakpoint
DROP INDEX "outbox_events_unpublished_idx";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "must_change_password" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "failed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "outbox_events_failed_idx" ON "outbox_events" USING btree ("organization_id","failed_at") WHERE "outbox_events"."failed_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "outbox_events_published_at_idx" ON "outbox_events" USING btree ("published_at") WHERE "outbox_events"."published_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "outbox_events_unpublished_idx" ON "outbox_events" USING btree ("sequence") WHERE "outbox_events"."published_at" IS NULL AND "outbox_events"."failed_at" IS NULL;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_category_valid" CHECK ("audit_events"."category" IN ('ACCESS', 'SECURITY', 'HR', 'SCHEDULING', 'ORDERS', 'MENU', 'INVENTORY', 'SETTLEMENTS', 'REPORTING', 'SYSTEM'));--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_published_or_failed" CHECK (NOT ("outbox_events"."published_at" IS NOT NULL AND "outbox_events"."failed_at" IS NOT NULL));