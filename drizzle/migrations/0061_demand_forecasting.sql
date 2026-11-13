CREATE TABLE "demand_excluded_dates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"excluded_date" date NOT NULL,
	"reason" text NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"deactivated_at" timestamp with time zone,
	"deactivated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "demand_excluded_dates_reason_present" CHECK (length(btrim("demand_excluded_dates"."reason")) > 0),
	CONSTRAINT "demand_excluded_dates_deactivation_consistent" CHECK ("demand_excluded_dates"."active" = ("demand_excluded_dates"."deactivated_at" IS NULL) AND ("demand_excluded_dates"."deactivated_at" IS NULL) = ("demand_excluded_dates"."deactivated_by_user_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "demand_forecast_dates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"demand_forecast_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"status" text NOT NULL,
	"sample_dates" date[] NOT NULL,
	CONSTRAINT "demand_forecast_dates_forecast_date_unique" UNIQUE("demand_forecast_id","business_date"),
	CONSTRAINT "demand_forecast_dates_status_valid" CHECK ("demand_forecast_dates"."status" IN ('OK', 'NOT_ENOUGH_HISTORY', 'BOOKINGS_ONLY'))
);
--> statement-breakpoint
CREATE TABLE "demand_forecast_hours" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"demand_forecast_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"hour" integer NOT NULL,
	"measure" text NOT NULL,
	"history_value" numeric(10, 2),
	"booked_value" integer DEFAULT 0 NOT NULL,
	"forecast_value" numeric(10, 2),
	"sample_count" integer NOT NULL,
	CONSTRAINT "demand_forecast_hours_forecast_slot_unique" UNIQUE("demand_forecast_id","business_date","hour","measure"),
	CONSTRAINT "demand_forecast_hours_hour_valid" CHECK ("demand_forecast_hours"."hour" BETWEEN 0 AND 23),
	CONSTRAINT "demand_forecast_hours_measure_valid" CHECK ("demand_forecast_hours"."measure" IN ('DINING_COVERS', 'BAR_CHECKS', 'TAKEOUT_CHECKS', 'ALL_CHECKS')),
	CONSTRAINT "demand_forecast_hours_values_valid" CHECK ("demand_forecast_hours"."booked_value" >= 0 AND "demand_forecast_hours"."sample_count" >= 0 AND ("demand_forecast_hours"."history_value" IS NULL OR "demand_forecast_hours"."history_value" >= 0) AND ("demand_forecast_hours"."forecast_value" IS NULL OR "demand_forecast_hours"."forecast_value" >= 0))
);
--> statement-breakpoint
CREATE TABLE "demand_forecasts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"schedule_period_id" uuid NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"lookback_weeks" integer NOT NULL,
	"minimum_samples" integer NOT NULL,
	"method" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staffing_ratios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"position_id" uuid NOT NULL,
	"measure" text NOT NULL,
	"units_per_employee_hour" numeric(8, 2) NOT NULL,
	"minimum_employees" integer DEFAULT 1 NOT NULL,
	"maximum_employees" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "staffing_ratios_measure_valid" CHECK ("staffing_ratios"."measure" IN ('DINING_COVERS', 'BAR_CHECKS', 'TAKEOUT_CHECKS', 'ALL_CHECKS')),
	CONSTRAINT "staffing_ratios_units_positive" CHECK ("staffing_ratios"."units_per_employee_hour" > 0),
	CONSTRAINT "staffing_ratios_headcount_valid" CHECK ("staffing_ratios"."minimum_employees" >= 0 AND "staffing_ratios"."maximum_employees" >= 1 AND "staffing_ratios"."maximum_employees" >= "staffing_ratios"."minimum_employees")
);
--> statement-breakpoint
ALTER TABLE "scheduling_rules" ADD COLUMN "forecast_lookback_weeks" integer DEFAULT 6 NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduling_rules" ADD COLUMN "forecast_minimum_samples" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "shifts" ADD COLUMN "demand_forecast_id" uuid;--> statement-breakpoint
ALTER TABLE "shifts" ADD COLUMN "forecast_suggested_count" integer;--> statement-breakpoint
ALTER TABLE "shifts" ADD COLUMN "template_employee_count" integer;--> statement-breakpoint
ALTER TABLE "demand_excluded_dates" ADD CONSTRAINT "demand_excluded_dates_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demand_excluded_dates" ADD CONSTRAINT "demand_excluded_dates_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demand_excluded_dates" ADD CONSTRAINT "demand_excluded_dates_deactivated_by_user_id_users_id_fk" FOREIGN KEY ("deactivated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demand_forecast_dates" ADD CONSTRAINT "demand_forecast_dates_forecast_fk" FOREIGN KEY ("demand_forecast_id") REFERENCES "public"."demand_forecasts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demand_forecast_hours" ADD CONSTRAINT "demand_forecast_hours_forecast_fk" FOREIGN KEY ("demand_forecast_id") REFERENCES "public"."demand_forecasts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demand_forecasts" ADD CONSTRAINT "demand_forecasts_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demand_forecasts" ADD CONSTRAINT "demand_forecasts_period_location_fk" FOREIGN KEY ("schedule_period_id","location_id") REFERENCES "public"."schedule_periods"("id","location_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staffing_ratios" ADD CONSTRAINT "staffing_ratios_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staffing_ratios" ADD CONSTRAINT "staffing_ratios_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "demand_excluded_dates_location_date_active_unique" ON "demand_excluded_dates" USING btree ("location_id","excluded_date") WHERE "demand_excluded_dates"."active";--> statement-breakpoint
CREATE INDEX "demand_forecast_dates_business_date_idx" ON "demand_forecast_dates" USING btree ("business_date");--> statement-breakpoint
CREATE INDEX "demand_forecasts_location_id_created_at_idx" ON "demand_forecasts" USING btree ("location_id","created_at");--> statement-breakpoint
CREATE INDEX "demand_forecasts_schedule_period_id_idx" ON "demand_forecasts" USING btree ("schedule_period_id");--> statement-breakpoint
CREATE UNIQUE INDEX "staffing_ratios_location_position_active_unique" ON "staffing_ratios" USING btree ("location_id","position_id") WHERE "staffing_ratios"."active";--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_demand_forecast_fk" FOREIGN KEY ("demand_forecast_id") REFERENCES "public"."demand_forecasts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduling_rules" ADD CONSTRAINT "scheduling_rules_forecast_settings_valid" CHECK ("scheduling_rules"."forecast_lookback_weeks" BETWEEN 1 AND 12 AND "scheduling_rules"."forecast_minimum_samples" BETWEEN 1 AND "scheduling_rules"."forecast_lookback_weeks");--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_forecast_columns_valid" CHECK (("shifts"."demand_forecast_id" IS NULL) = ("shifts"."forecast_suggested_count" IS NULL) AND ("shifts"."forecast_suggested_count" IS NULL OR "shifts"."forecast_suggested_count" > 0) AND ("shifts"."template_employee_count" IS NULL OR "shifts"."template_employee_count" > 0));