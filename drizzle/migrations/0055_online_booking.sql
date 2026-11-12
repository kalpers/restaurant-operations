CREATE TABLE "online_booking_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"weekday" integer NOT NULL,
	"starts_at" time NOT NULL,
	"ends_at" time NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "online_booking_periods_weekday_valid" CHECK ("online_booking_periods"."weekday" BETWEEN 0 AND 6),
	CONSTRAINT "online_booking_periods_order_valid" CHECK ("online_booking_periods"."ends_at" > "online_booking_periods"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "online_booking_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"requires_approval" boolean DEFAULT false NOT NULL,
	"max_party_size" integer DEFAULT 6 NOT NULL,
	"min_lead_minutes" integer DEFAULT 120 NOT NULL,
	"max_days_ahead" integer DEFAULT 30 NOT NULL,
	"slot_interval_minutes" integer DEFAULT 15 NOT NULL,
	"max_covers_per_slot" integer DEFAULT 20 NOT NULL,
	"reminder_hours_before" integer DEFAULT 24 NOT NULL,
	"public_note" text,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "online_booking_settings_location_id_unique" UNIQUE("location_id"),
	CONSTRAINT "online_booking_settings_party_size_valid" CHECK ("online_booking_settings"."max_party_size" BETWEEN 1 AND 50),
	CONSTRAINT "online_booking_settings_lead_valid" CHECK ("online_booking_settings"."min_lead_minutes" BETWEEN 0 AND 10080),
	CONSTRAINT "online_booking_settings_days_ahead_valid" CHECK ("online_booking_settings"."max_days_ahead" BETWEEN 1 AND 365),
	CONSTRAINT "online_booking_settings_interval_valid" CHECK ("online_booking_settings"."slot_interval_minutes" IN (15, 30, 60)),
	CONSTRAINT "online_booking_settings_covers_valid" CHECK ("online_booking_settings"."max_covers_per_slot" BETWEEN 1 AND 1000),
	CONSTRAINT "online_booking_settings_reminder_valid" CHECK ("online_booking_settings"."reminder_hours_before" BETWEEN 0 AND 168),
	CONSTRAINT "online_booking_settings_public_note_valid" CHECK ("online_booking_settings"."public_note" IS NULL OR (length("online_booking_settings"."public_note") <= 500 AND "online_booking_settings"."public_note" !~ '[0-9]{13,}'))
);
--> statement-breakpoint
CREATE TABLE "public_throttles" (
	"key_hash" text PRIMARY KEY NOT NULL,
	"attempts" integer NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "public_throttles_attempts_positive" CHECK ("public_throttles"."attempts" > 0),
	CONSTRAINT "public_throttles_key_hash_format" CHECK ("public_throttles"."key_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_actor_type_valid";--> statement-breakpoint
ALTER TABLE "guest_party_allergies" DROP CONSTRAINT "guest_party_allergies_source_valid";--> statement-breakpoint
ALTER TABLE "reservations" DROP CONSTRAINT "reservations_source_valid";--> statement-breakpoint
ALTER TABLE "reservations" DROP CONSTRAINT "reservations_cancelled_metadata";--> statement-breakpoint
ALTER TABLE "guest_party_allergies" ALTER COLUMN "recorded_by_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "reservations" ALTER COLUMN "created_by_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "cancelled_by_guest" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "online_request_key_hash" text;--> statement-breakpoint
ALTER TABLE "online_booking_periods" ADD CONSTRAINT "online_booking_periods_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "online_booking_settings" ADD CONSTRAINT "online_booking_settings_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "online_booking_settings" ADD CONSTRAINT "online_booking_settings_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "online_booking_periods_location_weekday_idx" ON "online_booking_periods" USING btree ("location_id","weekday");--> statement-breakpoint
CREATE UNIQUE INDEX "reservations_online_request_key_hash_unique" ON "reservations" USING btree ("online_request_key_hash") WHERE "reservations"."online_request_key_hash" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_type_valid" CHECK ("audit_events"."actor_type" IN ('USER', 'SYSTEM', 'GUEST'));--> statement-breakpoint
ALTER TABLE "guest_party_allergies" ADD CONSTRAINT "guest_party_allergies_recorded_by_online_only" CHECK (("guest_party_allergies"."recorded_by_user_id" IS NULL) = ("guest_party_allergies"."source" = 'ONLINE'));--> statement-breakpoint
ALTER TABLE "guest_party_allergies" ADD CONSTRAINT "guest_party_allergies_source_valid" CHECK ("guest_party_allergies"."source" IN ('PROFILE', 'RECORDED', 'ONLINE'));--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_online_request_key_online_only" CHECK ("reservations"."online_request_key_hash" IS NULL OR ("reservations"."source" = 'ONLINE' AND "reservations"."online_request_key_hash" ~ '^[0-9a-f]{64}$'));--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_created_by_online_only" CHECK (("reservations"."created_by_user_id" IS NULL) = ("reservations"."source" = 'ONLINE'));--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_source_valid" CHECK ("reservations"."source" IN ('PHONE', 'IN_PERSON', 'INTERNAL', 'WALK_IN_FUTURE', 'ONLINE'));--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_cancelled_metadata" CHECK (("reservations"."status" = 'CANCELLED') = ("reservations"."cancelled_at" IS NOT NULL)
        AND CASE WHEN "reservations"."cancelled_at" IS NULL
          THEN "reservations"."cancelled_by_user_id" IS NULL AND NOT "reservations"."cancelled_by_guest"
          ELSE ("reservations"."cancelled_by_user_id" IS NOT NULL) <> "reservations"."cancelled_by_guest" END);