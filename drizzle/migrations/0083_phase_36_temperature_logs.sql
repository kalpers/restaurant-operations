CREATE TABLE "temperature_points" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"unit" text NOT NULL,
	"minimum_value" numeric(5, 1),
	"maximum_value" numeric(5, 1),
	"check_interval_minutes" smallint,
	"sort_order" smallint DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by_user_id" uuid,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "temperature_points_id_location_unique" UNIQUE("id","location_id"),
	CONSTRAINT "temperature_points_name_length" CHECK (char_length("temperature_points"."name") BETWEEN 1 AND 80),
	CONSTRAINT "temperature_points_kind_valid" CHECK ("temperature_points"."kind" IN ('COLD_HOLDING', 'FROZEN', 'HOT_HOLDING', 'COOKING', 'COOLING', 'RECEIVING', 'OTHER')),
	CONSTRAINT "temperature_points_unit_valid" CHECK ("temperature_points"."unit" IN ('F', 'C')),
	CONSTRAINT "temperature_points_range_valid" CHECK ("temperature_points"."minimum_value" IS NULL OR "temperature_points"."maximum_value" IS NULL OR "temperature_points"."minimum_value" <= "temperature_points"."maximum_value"),
	CONSTRAINT "temperature_points_interval_valid" CHECK ("temperature_points"."check_interval_minutes" IS NULL OR "temperature_points"."check_interval_minutes" BETWEEN 30 AND 1440)
);
--> statement-breakpoint
CREATE TABLE "temperature_readings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"point_id" uuid NOT NULL,
	"point_name_snapshot" text NOT NULL,
	"value" numeric(5, 1) NOT NULL,
	"unit" text NOT NULL,
	"minimum_value" numeric(5, 1),
	"maximum_value" numeric(5, 1),
	"in_range" boolean NOT NULL,
	"corrective_action" text,
	"taken_at" timestamp with time zone NOT NULL,
	"business_date" date NOT NULL,
	"recorded_by_user_id" uuid NOT NULL,
	"recorded_by_employee_id" uuid,
	"follows_up_reading_id" uuid,
	"corrects_reading_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "temperature_readings_unit_valid" CHECK ("temperature_readings"."unit" IN ('F', 'C')),
	CONSTRAINT "temperature_readings_value_plausible" CHECK ("temperature_readings"."value" BETWEEN -100 AND 600),
	CONSTRAINT "temperature_readings_in_range_matches" CHECK ("temperature_readings"."in_range" = (("temperature_readings"."minimum_value" IS NULL OR "temperature_readings"."value" >= "temperature_readings"."minimum_value")
        AND ("temperature_readings"."maximum_value" IS NULL OR "temperature_readings"."value" <= "temperature_readings"."maximum_value"))),
	CONSTRAINT "temperature_readings_corrective_action" CHECK (("temperature_readings"."in_range" OR "temperature_readings"."corrective_action" IS NOT NULL)
        AND ("temperature_readings"."corrective_action" IS NULL OR char_length("temperature_readings"."corrective_action") BETWEEN 1 AND 500)),
	CONSTRAINT "temperature_readings_no_card_digits" CHECK (coalesce("temperature_readings"."corrective_action", '') !~ '[0-9]{13,}'),
	CONSTRAINT "temperature_readings_not_self" CHECK (("temperature_readings"."follows_up_reading_id" IS NULL OR "temperature_readings"."follows_up_reading_id" <> "temperature_readings"."id")
        AND ("temperature_readings"."corrects_reading_id" IS NULL OR "temperature_readings"."corrects_reading_id" <> "temperature_readings"."id"))
);
--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_type_valid";--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_link_matches_type";--> statement-breakpoint
ALTER TABLE "free_text_redactions" DROP CONSTRAINT "free_text_redactions_table_valid";--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "temperature_reading_id" uuid;--> statement-breakpoint
ALTER TABLE "location_settings" ADD COLUMN "temperature_unit" text DEFAULT 'F' NOT NULL;--> statement-breakpoint
ALTER TABLE "temperature_points" ADD CONSTRAINT "temperature_points_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "temperature_points" ADD CONSTRAINT "temperature_points_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "temperature_points" ADD CONSTRAINT "temperature_points_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "temperature_points" ADD CONSTRAINT "temperature_points_location_org_fk" FOREIGN KEY ("location_id","organization_id") REFERENCES "public"."locations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "temperature_readings" ADD CONSTRAINT "temperature_readings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "temperature_readings" ADD CONSTRAINT "temperature_readings_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "temperature_readings" ADD CONSTRAINT "temperature_readings_recorded_by_employee_id_employees_id_fk" FOREIGN KEY ("recorded_by_employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "temperature_readings" ADD CONSTRAINT "temperature_readings_point_location_fk" FOREIGN KEY ("point_id","location_id") REFERENCES "public"."temperature_points"("id","location_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "temperature_readings" ADD CONSTRAINT "temperature_readings_location_org_fk" FOREIGN KEY ("location_id","organization_id") REFERENCES "public"."locations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "temperature_readings" ADD CONSTRAINT "temperature_readings_follows_up_fk" FOREIGN KEY ("follows_up_reading_id") REFERENCES "public"."temperature_readings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "temperature_readings" ADD CONSTRAINT "temperature_readings_corrects_fk" FOREIGN KEY ("corrects_reading_id") REFERENCES "public"."temperature_readings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "temperature_points_location_idx" ON "temperature_points" USING btree ("location_id","active");--> statement-breakpoint
CREATE INDEX "temperature_readings_location_date_idx" ON "temperature_readings" USING btree ("location_id","business_date","taken_at");--> statement-breakpoint
CREATE INDEX "temperature_readings_point_taken_idx" ON "temperature_readings" USING btree ("point_id","taken_at");--> statement-breakpoint
CREATE INDEX "temperature_readings_corrects_idx" ON "temperature_readings" USING btree ("corrects_reading_id");--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_temperature_reading_fk" FOREIGN KEY ("temperature_reading_id") REFERENCES "public"."temperature_readings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_type_valid" CHECK ("notifications"."notification_type" IN ('FOOD_READY', 'BAR_ORDER_READY', 'INVENTORY_LOW', 'SCHEDULE_PUBLISHED', 'SHIFT_CHANGED', 'TIME_OFF_APPROVED', 'TIME_OFF_DENIED', 'CERTIFICATION_EXPIRING', 'OVERTIME_APPROACHING', 'MISSED_CLOCK_OUT', 'LOT_EXPIRING', 'TEMPERATURE_OUT_OF_RANGE'));--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_link_matches_type" CHECK (("notifications"."notification_type" <> 'SCHEDULE_PUBLISHED' OR "notifications"."schedule_period_id" IS NOT NULL)
        AND ("notifications"."notification_type" <> 'SHIFT_CHANGED' OR "notifications"."shift_swap_request_id" IS NOT NULL)
        AND ("notifications"."notification_type" NOT IN ('TIME_OFF_APPROVED', 'TIME_OFF_DENIED') OR "notifications"."time_off_request_id" IS NOT NULL)
        AND ("notifications"."notification_type" <> 'CERTIFICATION_EXPIRING' OR ("notifications"."employee_certification_id" IS NOT NULL AND "notifications"."dedupe_key" IS NOT NULL))
        AND ("notifications"."notification_type" NOT IN ('OVERTIME_APPROACHING', 'MISSED_CLOCK_OUT') OR ("notifications"."time_entry_id" IS NOT NULL AND "notifications"."dedupe_key" IS NOT NULL))
        AND ("notifications"."notification_type" <> 'LOT_EXPIRING' OR ("notifications"."inventory_lot_id" IS NOT NULL AND "notifications"."dedupe_key" IS NOT NULL))
        AND ("notifications"."notification_type" <> 'TEMPERATURE_OUT_OF_RANGE' OR ("notifications"."temperature_reading_id" IS NOT NULL AND "notifications"."dedupe_key" IS NOT NULL)));--> statement-breakpoint
ALTER TABLE "location_settings" ADD CONSTRAINT "location_settings_temperature_unit_valid" CHECK ("location_settings"."temperature_unit" IN ('F', 'C'));--> statement-breakpoint
ALTER TABLE "free_text_redactions" ADD CONSTRAINT "free_text_redactions_table_valid" CHECK ("free_text_redactions"."table_name" IN ('guest_parties', 'reservations', 'waitlist_entries', 'table_sessions', 'orders', 'order_items', 'kitchen_ticket_items', 'shifts', 'shift_assignments', 'gift_card_purchasers', 'checklist_run_items', 'temperature_readings'));