CREATE TABLE "guest_parties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"party_size" integer NOT NULL,
	"guest_name" text NOT NULL,
	"phone" text,
	"email" text,
	"special_requests" text,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "guest_parties_id_location_id_unique" UNIQUE("id","location_id"),
	CONSTRAINT "guest_parties_party_size_positive" CHECK ("guest_parties"."party_size" > 0),
	CONSTRAINT "guest_parties_guest_name_not_blank" CHECK (length(trim("guest_parties"."guest_name")) > 0),
	CONSTRAINT "guest_parties_status_valid" CHECK ("guest_parties"."status" IN ('EXPECTED', 'WAITING', 'CHECKED_IN', 'SEATED', 'COMPLETED', 'CANCELLED', 'NO_SHOW'))
);
--> statement-breakpoint
CREATE TABLE "party_status_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guest_party_id" uuid NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"changed_by_user_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "party_status_history_status_valid" CHECK ("party_status_history"."status" IN ('EXPECTED', 'WAITING', 'CHECKED_IN', 'SEATED', 'COMPLETED', 'CANCELLED', 'NO_SHOW'))
);
--> statement-breakpoint
CREATE TABLE "reservation_hold_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reservation_id" uuid NOT NULL,
	"table_session_id" uuid NOT NULL,
	"restaurant_table_id" uuid NOT NULL,
	"category" text DEFAULT 'RESERVATION_HOLD_OVERRIDE' NOT NULL,
	"reason" text NOT NULL,
	"overridden_by_user_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reservation_hold_overrides_category_valid" CHECK ("reservation_hold_overrides"."category" = 'RESERVATION_HOLD_OVERRIDE'),
	CONSTRAINT "reservation_hold_overrides_reason_not_blank" CHECK (length(trim("reservation_hold_overrides"."reason")) > 0)
);
--> statement-breakpoint
CREATE TABLE "reservation_table_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reservation_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"restaurant_table_id" uuid NOT NULL,
	"assigned_by_user_id" uuid NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_by_user_id" uuid,
	"removal_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reservation_table_assignments_removal_valid" CHECK (("reservation_table_assignments"."removed_at" IS NULL) = ("reservation_table_assignments"."removal_reason" IS NULL) AND ("reservation_table_assignments"."removal_reason" IS NULL OR "reservation_table_assignments"."removal_reason" IN ('REPLACED', 'CANCELLED', 'NO_SHOW', 'SEATED', 'REMOVED')))
);
--> statement-breakpoint
CREATE TABLE "reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guest_party_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"reservation_at" timestamp with time zone NOT NULL,
	"business_date" date NOT NULL,
	"expected_duration_minutes" integer NOT NULL,
	"status" text NOT NULL,
	"source" text NOT NULL,
	"notes" text,
	"checked_in_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancelled_by_user_id" uuid,
	"cancel_reason" text,
	"no_show_at" timestamp with time zone,
	"no_show_by_user_id" uuid,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "reservations_guest_party_id_unique" UNIQUE("guest_party_id"),
	CONSTRAINT "reservations_id_location_id_unique" UNIQUE("id","location_id"),
	CONSTRAINT "reservations_status_valid" CHECK ("reservations"."status" IN ('PENDING', 'CONFIRMED', 'CHECKED_IN', 'SEATED', 'COMPLETED', 'CANCELLED', 'NO_SHOW')),
	CONSTRAINT "reservations_source_valid" CHECK ("reservations"."source" IN ('PHONE', 'IN_PERSON', 'INTERNAL', 'WALK_IN_FUTURE')),
	CONSTRAINT "reservations_duration_positive" CHECK ("reservations"."expected_duration_minutes" > 0),
	CONSTRAINT "reservations_cancelled_metadata" CHECK (("reservations"."status" = 'CANCELLED') = ("reservations"."cancelled_at" IS NOT NULL) AND ("reservations"."cancelled_at" IS NULL) = ("reservations"."cancelled_by_user_id" IS NULL)),
	CONSTRAINT "reservations_no_show_metadata" CHECK (("reservations"."status" = 'NO_SHOW') = ("reservations"."no_show_at" IS NOT NULL) AND ("reservations"."no_show_at" IS NULL) = ("reservations"."no_show_by_user_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "waitlist_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guest_party_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"status" text NOT NULL,
	"quoted_wait_minutes" integer,
	"preferred_area_id" uuid,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notified_at" timestamp with time zone,
	"notified_by_user_id" uuid,
	"seated_at" timestamp with time zone,
	"removed_at" timestamp with time zone,
	"removed_by_user_id" uuid,
	"created_by_user_id" uuid NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "waitlist_entries_id_location_id_unique" UNIQUE("id","location_id"),
	CONSTRAINT "waitlist_entries_status_valid" CHECK ("waitlist_entries"."status" IN ('WAITING', 'NOTIFIED', 'TABLE_ASSIGNED', 'SEATED', 'CANCELLED', 'LEFT')),
	CONSTRAINT "waitlist_entries_quote_non_negative" CHECK ("waitlist_entries"."quoted_wait_minutes" IS NULL OR "waitlist_entries"."quoted_wait_minutes" >= 0),
	CONSTRAINT "waitlist_entries_seated_metadata" CHECK (("waitlist_entries"."status" = 'SEATED') = ("waitlist_entries"."seated_at" IS NOT NULL)),
	CONSTRAINT "waitlist_entries_removed_metadata" CHECK (("waitlist_entries"."status" IN ('CANCELLED', 'LEFT')) = ("waitlist_entries"."removed_at" IS NOT NULL) AND ("waitlist_entries"."removed_at" IS NULL) = ("waitlist_entries"."removed_by_user_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "waitlist_table_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"waitlist_entry_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"restaurant_table_id" uuid NOT NULL,
	"assigned_by_user_id" uuid NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"removal_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "waitlist_table_assignments_removal_valid" CHECK (("waitlist_table_assignments"."removed_at" IS NULL) = ("waitlist_table_assignments"."removal_reason" IS NULL) AND ("waitlist_table_assignments"."removal_reason" IS NULL OR "waitlist_table_assignments"."removal_reason" IN ('REPLACED', 'SEATED', 'CANCELLED', 'LEFT', 'REMOVED')))
);
--> statement-breakpoint
ALTER TABLE "location_settings" ADD COLUMN "reservation_pre_hold_minutes" integer DEFAULT 15 NOT NULL;--> statement-breakpoint
ALTER TABLE "location_settings" ADD COLUMN "reservation_post_grace_minutes" integer DEFAULT 15 NOT NULL;--> statement-breakpoint
ALTER TABLE "table_sessions" ADD COLUMN "guest_party_id" uuid;--> statement-breakpoint
ALTER TABLE "guest_parties" ADD CONSTRAINT "guest_parties_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_status_history" ADD CONSTRAINT "party_status_history_guest_party_id_guest_parties_id_fk" FOREIGN KEY ("guest_party_id") REFERENCES "public"."guest_parties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_status_history" ADD CONSTRAINT "party_status_history_changed_by_user_id_users_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_hold_overrides" ADD CONSTRAINT "reservation_hold_overrides_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_hold_overrides" ADD CONSTRAINT "reservation_hold_overrides_overridden_by_user_id_users_id_fk" FOREIGN KEY ("overridden_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_hold_overrides" ADD CONSTRAINT "reservation_hold_overrides_session_fk" FOREIGN KEY ("table_session_id") REFERENCES "public"."table_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_hold_overrides" ADD CONSTRAINT "reservation_hold_overrides_table_fk" FOREIGN KEY ("restaurant_table_id") REFERENCES "public"."restaurant_tables"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_table_assignments" ADD CONSTRAINT "reservation_table_assignments_assigned_by_user_id_users_id_fk" FOREIGN KEY ("assigned_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_table_assignments" ADD CONSTRAINT "reservation_table_assignments_removed_by_user_id_users_id_fk" FOREIGN KEY ("removed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_table_assignments" ADD CONSTRAINT "reservation_table_assignments_reservation_location_fk" FOREIGN KEY ("reservation_id","location_id") REFERENCES "public"."reservations"("id","location_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_table_assignments" ADD CONSTRAINT "reservation_table_assignments_table_location_fk" FOREIGN KEY ("restaurant_table_id","location_id") REFERENCES "public"."restaurant_tables"("id","location_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_cancelled_by_user_id_users_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_no_show_by_user_id_users_id_fk" FOREIGN KEY ("no_show_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_guest_party_location_fk" FOREIGN KEY ("guest_party_id","location_id") REFERENCES "public"."guest_parties"("id","location_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_notified_by_user_id_users_id_fk" FOREIGN KEY ("notified_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_removed_by_user_id_users_id_fk" FOREIGN KEY ("removed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_guest_party_location_fk" FOREIGN KEY ("guest_party_id","location_id") REFERENCES "public"."guest_parties"("id","location_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_preferred_area_location_fk" FOREIGN KEY ("preferred_area_id","location_id") REFERENCES "public"."restaurant_areas"("id","location_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_table_assignments" ADD CONSTRAINT "waitlist_table_assignments_assigned_by_user_id_users_id_fk" FOREIGN KEY ("assigned_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_table_assignments" ADD CONSTRAINT "waitlist_table_assignments_entry_location_fk" FOREIGN KEY ("waitlist_entry_id","location_id") REFERENCES "public"."waitlist_entries"("id","location_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_table_assignments" ADD CONSTRAINT "waitlist_table_assignments_table_location_fk" FOREIGN KEY ("restaurant_table_id","location_id") REFERENCES "public"."restaurant_tables"("id","location_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "guest_parties_location_id_status_idx" ON "guest_parties" USING btree ("location_id","status");--> statement-breakpoint
CREATE INDEX "party_status_history_guest_party_id_occurred_at_idx" ON "party_status_history" USING btree ("guest_party_id","occurred_at");--> statement-breakpoint
CREATE INDEX "reservation_hold_overrides_reservation_id_idx" ON "reservation_hold_overrides" USING btree ("reservation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reservation_table_assignments_one_active_unique" ON "reservation_table_assignments" USING btree ("reservation_id","restaurant_table_id") WHERE "reservation_table_assignments"."removed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "reservation_table_assignments_table_idx" ON "reservation_table_assignments" USING btree ("restaurant_table_id");--> statement-breakpoint
CREATE INDEX "reservations_location_id_business_date_idx" ON "reservations" USING btree ("location_id","business_date");--> statement-breakpoint
CREATE INDEX "reservations_location_id_status_reservation_at_idx" ON "reservations" USING btree ("location_id","status","reservation_at");--> statement-breakpoint
CREATE UNIQUE INDEX "waitlist_entries_one_open_per_party_unique" ON "waitlist_entries" USING btree ("guest_party_id") WHERE "waitlist_entries"."status" IN ('WAITING', 'NOTIFIED', 'TABLE_ASSIGNED');--> statement-breakpoint
CREATE INDEX "waitlist_entries_location_id_status_idx" ON "waitlist_entries" USING btree ("location_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "waitlist_table_assignments_one_active_unique" ON "waitlist_table_assignments" USING btree ("waitlist_entry_id","restaurant_table_id") WHERE "waitlist_table_assignments"."removed_at" IS NULL;--> statement-breakpoint
ALTER TABLE "table_sessions" ADD CONSTRAINT "table_sessions_guest_party_location_fk" FOREIGN KEY ("guest_party_id","location_id") REFERENCES "public"."guest_parties"("id","location_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "table_sessions_one_active_per_guest_party_unique" ON "table_sessions" USING btree ("guest_party_id") WHERE "table_sessions"."status" = 'ACTIVE' AND "table_sessions"."guest_party_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "location_settings" ADD CONSTRAINT "location_settings_reservation_hold_non_negative" CHECK ("location_settings"."reservation_pre_hold_minutes" >= 0 AND "location_settings"."reservation_post_grace_minutes" >= 0);