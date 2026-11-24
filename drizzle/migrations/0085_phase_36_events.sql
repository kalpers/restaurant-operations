CREATE TABLE "event_booking_tables" (
	"event_booking_id" uuid NOT NULL,
	"restaurant_table_id" uuid NOT NULL,
	CONSTRAINT "event_booking_tables_pk" PRIMARY KEY("event_booking_id","restaurant_table_id")
);
--> statement-breakpoint
CREATE TABLE "event_bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"guest_party_id" uuid NOT NULL,
	"event_number" integer NOT NULL,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"space_scope" text NOT NULL,
	"restaurant_area_id" uuid,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"setup_minutes" smallint DEFAULT 0 NOT NULL,
	"teardown_minutes" smallint DEFAULT 0 NOT NULL,
	"business_date" date NOT NULL,
	"notes" text,
	"menu_notes" text,
	"menu_item_id" uuid,
	"minimum_spend" numeric(12, 2),
	"deposit_agreed" numeric(12, 2),
	"deposit_received" numeric(12, 2),
	"deposit_received_on" date,
	"deposit_method" text,
	"deposit_reference" text,
	"cancelled_at" timestamp with time zone,
	"cancelled_by_user_id" uuid,
	"cancel_reason" text,
	"completed_at" timestamp with time zone,
	"created_by_user_id" uuid NOT NULL,
	"updated_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "event_bookings_party_unique" UNIQUE("guest_party_id"),
	CONSTRAINT "event_bookings_org_number_unique" UNIQUE("organization_id","event_number"),
	CONSTRAINT "event_bookings_number_positive" CHECK ("event_bookings"."event_number" > 0),
	CONSTRAINT "event_bookings_name_length" CHECK (char_length("event_bookings"."name") BETWEEN 1 AND 120),
	CONSTRAINT "event_bookings_status_valid" CHECK ("event_bookings"."status" IN ('INQUIRY', 'TENTATIVE', 'CONFIRMED', 'COMPLETED', 'CANCELLED')),
	CONSTRAINT "event_bookings_scope_valid" CHECK ("event_bookings"."space_scope" IN ('TABLES', 'AREA', 'LOCATION')),
	CONSTRAINT "event_bookings_area_matches_scope" CHECK (("event_bookings"."space_scope" = 'LOCATION') = ("event_bookings"."restaurant_area_id" IS NULL)),
	CONSTRAINT "event_bookings_times_valid" CHECK ("event_bookings"."ends_at" > "event_bookings"."starts_at" AND "event_bookings"."ends_at" <= "event_bookings"."starts_at" + interval '24 hours'),
	CONSTRAINT "event_bookings_buffers_valid" CHECK ("event_bookings"."setup_minutes" BETWEEN 0 AND 480 AND "event_bookings"."teardown_minutes" BETWEEN 0 AND 480),
	CONSTRAINT "event_bookings_notes_length" CHECK ("event_bookings"."notes" IS NULL OR char_length("event_bookings"."notes") BETWEEN 1 AND 4000),
	CONSTRAINT "event_bookings_menu_notes_length" CHECK ("event_bookings"."menu_notes" IS NULL OR char_length("event_bookings"."menu_notes") BETWEEN 1 AND 2000),
	CONSTRAINT "event_bookings_money_non_negative" CHECK (coalesce("event_bookings"."minimum_spend", 0) >= 0 AND coalesce("event_bookings"."deposit_agreed", 0) >= 0 AND coalesce("event_bookings"."deposit_received", 0) >= 0),
	CONSTRAINT "event_bookings_deposit_recorded" CHECK (("event_bookings"."deposit_received" IS NULL AND "event_bookings"."deposit_received_on" IS NULL AND "event_bookings"."deposit_method" IS NULL AND "event_bookings"."deposit_reference" IS NULL)
        OR ("event_bookings"."deposit_received" IS NOT NULL AND "event_bookings"."deposit_received_on" IS NOT NULL
          AND "event_bookings"."deposit_method" IN ('CASH', 'EXTERNAL_CARD', 'OTHER')
          AND ("event_bookings"."deposit_reference" IS NULL OR char_length("event_bookings"."deposit_reference") BETWEEN 1 AND 80))),
	CONSTRAINT "event_bookings_cancellation_recorded" CHECK (("event_bookings"."status" = 'CANCELLED') = ("event_bookings"."cancelled_at" IS NOT NULL)
        AND ("event_bookings"."cancelled_at" IS NULL OR ("event_bookings"."cancelled_by_user_id" IS NOT NULL AND char_length("event_bookings"."cancel_reason") BETWEEN 1 AND 500))),
	CONSTRAINT "event_bookings_completion_recorded" CHECK (("event_bookings"."status" = 'COMPLETED') = ("event_bookings"."completed_at" IS NOT NULL)),
	CONSTRAINT "event_bookings_no_card_digits" CHECK ("event_bookings"."name" !~ '[0-9]{13,}' AND coalesce("event_bookings"."notes", '') !~ '[0-9]{13,}'
        AND coalesce("event_bookings"."menu_notes", '') !~ '[0-9]{13,}' AND coalesce("event_bookings"."deposit_reference", '') !~ '[0-9]{13,}')
);
--> statement-breakpoint
CREATE TABLE "event_number_counters" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"last_number" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "event_number_counters_non_negative" CHECK ("event_number_counters"."last_number" >= 0)
);
--> statement-breakpoint
ALTER TABLE "free_text_redactions" DROP CONSTRAINT "free_text_redactions_table_valid";--> statement-breakpoint
ALTER TABLE "reservation_hold_overrides" DROP CONSTRAINT "reservation_hold_overrides_category_valid";--> statement-breakpoint
ALTER TABLE "reservation_hold_overrides" ALTER COLUMN "reservation_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "reservation_hold_overrides" ADD COLUMN "event_booking_id" uuid;--> statement-breakpoint
ALTER TABLE "event_booking_tables" ADD CONSTRAINT "event_booking_tables_event_fk" FOREIGN KEY ("event_booking_id") REFERENCES "public"."event_bookings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_booking_tables" ADD CONSTRAINT "event_booking_tables_table_fk" FOREIGN KEY ("restaurant_table_id") REFERENCES "public"."restaurant_tables"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_bookings" ADD CONSTRAINT "event_bookings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_bookings" ADD CONSTRAINT "event_bookings_menu_item_id_menu_items_id_fk" FOREIGN KEY ("menu_item_id") REFERENCES "public"."menu_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_bookings" ADD CONSTRAINT "event_bookings_cancelled_by_user_id_users_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_bookings" ADD CONSTRAINT "event_bookings_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_bookings" ADD CONSTRAINT "event_bookings_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_bookings" ADD CONSTRAINT "event_bookings_location_org_fk" FOREIGN KEY ("location_id","organization_id") REFERENCES "public"."locations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_bookings" ADD CONSTRAINT "event_bookings_party_location_fk" FOREIGN KEY ("guest_party_id","location_id") REFERENCES "public"."guest_parties"("id","location_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_bookings" ADD CONSTRAINT "event_bookings_area_fk" FOREIGN KEY ("restaurant_area_id") REFERENCES "public"."restaurant_areas"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_number_counters" ADD CONSTRAINT "event_number_counters_org_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_booking_tables_table_idx" ON "event_booking_tables" USING btree ("restaurant_table_id");--> statement-breakpoint
CREATE INDEX "event_bookings_location_starts_idx" ON "event_bookings" USING btree ("location_id","starts_at");--> statement-breakpoint
CREATE INDEX "event_bookings_location_date_idx" ON "event_bookings" USING btree ("location_id","business_date");--> statement-breakpoint
ALTER TABLE "reservation_hold_overrides" ADD CONSTRAINT "reservation_hold_overrides_event_fk" FOREIGN KEY ("event_booking_id") REFERENCES "public"."event_bookings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "free_text_redactions" ADD CONSTRAINT "free_text_redactions_table_valid" CHECK ("free_text_redactions"."table_name" IN ('guest_parties', 'reservations', 'waitlist_entries', 'table_sessions', 'orders', 'order_items', 'kitchen_ticket_items', 'shifts', 'shift_assignments', 'gift_card_purchasers', 'checklist_run_items', 'temperature_readings', 'event_bookings'));--> statement-breakpoint
ALTER TABLE "reservation_hold_overrides" ADD CONSTRAINT "reservation_hold_overrides_category_valid" CHECK (("reservation_hold_overrides"."category" = 'RESERVATION_HOLD_OVERRIDE' AND "reservation_hold_overrides"."reservation_id" IS NOT NULL AND "reservation_hold_overrides"."event_booking_id" IS NULL)
        OR ("reservation_hold_overrides"."category" = 'EVENT_HOLD_OVERRIDE' AND "reservation_hold_overrides"."event_booking_id" IS NOT NULL AND "reservation_hold_overrides"."reservation_id" IS NULL));