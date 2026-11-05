CREATE TABLE "employee_availability" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"location_id" uuid,
	"day_of_week" integer NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"availability_type" text NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "employee_availability_day_of_week_valid" CHECK ("employee_availability"."day_of_week" BETWEEN 0 AND 6),
	CONSTRAINT "employee_availability_type_valid" CHECK ("employee_availability"."availability_type" IN ('AVAILABLE', 'UNAVAILABLE')),
	CONSTRAINT "employee_availability_effective_range" CHECK ("employee_availability"."effective_to" IS NULL OR "employee_availability"."effective_from" <= "employee_availability"."effective_to")
);
--> statement-breakpoint
CREATE TABLE "employee_availability_exceptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"location_id" uuid,
	"exception_date" date NOT NULL,
	"start_time" time,
	"end_time" time,
	"availability_type" text NOT NULL,
	"reason" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "employee_availability_exceptions_type_valid" CHECK ("employee_availability_exceptions"."availability_type" IN ('AVAILABLE', 'UNAVAILABLE')),
	CONSTRAINT "employee_availability_exceptions_times_paired" CHECK (("employee_availability_exceptions"."start_time" IS NULL) = ("employee_availability_exceptions"."end_time" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "employee_scheduling_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"location_id" uuid,
	"target_hours_per_week" numeric(6, 2),
	"minimum_hours_per_week" numeric(6, 2),
	"maximum_hours_per_week" numeric(6, 2),
	"maximum_days_per_week" integer,
	"maximum_consecutive_days" integer,
	"preferred_shift_start" time,
	"preferred_shift_end" time,
	"prefer_weekends" boolean,
	"prefer_opening" boolean,
	"prefer_closing" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "employee_scheduling_preferences_employee_location_unique" UNIQUE NULLS NOT DISTINCT("employee_id","location_id"),
	CONSTRAINT "employee_scheduling_preferences_hours_order" CHECK ("employee_scheduling_preferences"."minimum_hours_per_week" IS NULL OR "employee_scheduling_preferences"."maximum_hours_per_week" IS NULL OR "employee_scheduling_preferences"."minimum_hours_per_week" <= "employee_scheduling_preferences"."maximum_hours_per_week"),
	CONSTRAINT "employee_scheduling_preferences_day_limits_valid" CHECK (("employee_scheduling_preferences"."maximum_days_per_week" IS NULL OR "employee_scheduling_preferences"."maximum_days_per_week" BETWEEN 1 AND 7) AND ("employee_scheduling_preferences"."maximum_consecutive_days" IS NULL OR "employee_scheduling_preferences"."maximum_consecutive_days" > 0)),
	CONSTRAINT "employee_scheduling_preferences_window_paired" CHECK (("employee_scheduling_preferences"."preferred_shift_start" IS NULL) = ("employee_scheduling_preferences"."preferred_shift_end" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "schedule_generation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schedule_period_id" uuid NOT NULL,
	"started_by_user_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"generation_mode" text NOT NULL,
	"status" text DEFAULT 'STARTED' NOT NULL,
	"rules_snapshot" jsonb,
	"created_assignment_count" integer DEFAULT 0 NOT NULL,
	"unfilled_shift_count" integer DEFAULT 0 NOT NULL,
	"warning_count" integer DEFAULT 0 NOT NULL,
	"unfilled_details" jsonb,
	"warnings" jsonb,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedule_generation_runs_mode_valid" CHECK ("schedule_generation_runs"."generation_mode" IN ('GENERATE_DRAFT', 'FILL_OPEN_SHIFTS')),
	CONSTRAINT "schedule_generation_runs_status_valid" CHECK ("schedule_generation_runs"."status" IN ('STARTED', 'COMPLETED', 'FAILED'))
);
--> statement-breakpoint
CREATE TABLE "schedule_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"name" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"published_at" timestamp with time zone,
	"published_by_user_id" uuid,
	"archived_at" timestamp with time zone,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "schedule_periods_id_location_id_unique" UNIQUE("id","location_id"),
	CONSTRAINT "schedule_periods_status_valid" CHECK ("schedule_periods"."status" IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')),
	CONSTRAINT "schedule_periods_date_range" CHECK ("schedule_periods"."start_date" <= "schedule_periods"."end_date"),
	CONSTRAINT "schedule_periods_published_metadata" CHECK (("schedule_periods"."status" = 'DRAFT') = ("schedule_periods"."published_at" IS NULL) AND ("schedule_periods"."published_at" IS NULL) = ("schedule_periods"."published_by_user_id" IS NULL)),
	CONSTRAINT "schedule_periods_archived_metadata" CHECK (("schedule_periods"."status" = 'ARCHIVED') = ("schedule_periods"."archived_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "scheduling_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"avoid_overtime" boolean DEFAULT true NOT NULL,
	"weekly_overtime_threshold" numeric(6, 2) DEFAULT '40.00' NOT NULL,
	"minimum_rest_hours" numeric(6, 2),
	"minimum_rest_hard" boolean DEFAULT false NOT NULL,
	"maximum_days_per_week" integer,
	"maximum_days_hard" boolean DEFAULT false NOT NULL,
	"maximum_consecutive_days" integer,
	"maximum_consecutive_hard" boolean DEFAULT false NOT NULL,
	"maximum_weekly_hours" numeric(6, 2),
	"balance_weekend_shifts" boolean DEFAULT true NOT NULL,
	"balance_closing_shifts" boolean DEFAULT true NOT NULL,
	"prefer_target_hours" boolean DEFAULT true NOT NULL,
	"week_start_day" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "scheduling_rules_location_id_unique" UNIQUE("location_id"),
	CONSTRAINT "scheduling_rules_week_start_day_valid" CHECK ("scheduling_rules"."week_start_day" BETWEEN 0 AND 6),
	CONSTRAINT "scheduling_rules_day_limits_valid" CHECK (("scheduling_rules"."maximum_days_per_week" IS NULL OR "scheduling_rules"."maximum_days_per_week" BETWEEN 1 AND 7) AND ("scheduling_rules"."maximum_consecutive_days" IS NULL OR "scheduling_rules"."maximum_consecutive_days" > 0)),
	CONSTRAINT "scheduling_rules_hard_limits_have_values" CHECK ((NOT "scheduling_rules"."minimum_rest_hard" OR "scheduling_rules"."minimum_rest_hours" IS NOT NULL) AND (NOT "scheduling_rules"."maximum_days_hard" OR "scheduling_rules"."maximum_days_per_week" IS NOT NULL) AND (NOT "scheduling_rules"."maximum_consecutive_hard" OR "scheduling_rules"."maximum_consecutive_days" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "shift_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shift_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"assignment_source" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"assigned_by_user_id" uuid,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notes" text,
	"generation_run_id" uuid,
	"generation_rationale" jsonb,
	"ended_at" timestamp with time zone,
	"ended_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "shift_assignments_source_valid" CHECK ("shift_assignments"."assignment_source" IN ('MANUAL', 'GENERATED', 'SHIFT_SWAP')),
	CONSTRAINT "shift_assignments_status_valid" CHECK ("shift_assignments"."status" IN ('ACTIVE', 'REMOVED', 'SWAPPED')),
	CONSTRAINT "shift_assignments_ended_matches_status" CHECK (("shift_assignments"."status" = 'ACTIVE') = ("shift_assignments"."ended_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "shift_swap_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shift_assignment_id" uuid NOT NULL,
	"requesting_employee_id" uuid NOT NULL,
	"target_employee_id" uuid,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"reason" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by_user_id" uuid,
	"approved_by_user_id" uuid,
	"approved_at" timestamp with time zone,
	"denied_by_user_id" uuid,
	"denied_at" timestamp with time zone,
	"replacement_assignment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "shift_swap_requests_status_valid" CHECK ("shift_swap_requests"."status" IN ('PENDING', 'ACCEPTED', 'DENIED', 'CANCELLED', 'COMPLETED')),
	CONSTRAINT "shift_swap_requests_target_differs" CHECK ("shift_swap_requests"."target_employee_id" IS NULL OR "shift_swap_requests"."target_employee_id" <> "shift_swap_requests"."requesting_employee_id"),
	CONSTRAINT "shift_swap_requests_completed_metadata" CHECK (("shift_swap_requests"."status" = 'COMPLETED') = ("shift_swap_requests"."replacement_assignment_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "shifts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schedule_period_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"position_id" uuid NOT NULL,
	"restaurant_area_id" uuid,
	"shift_date" date NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"required_employee_count" integer DEFAULT 1 NOT NULL,
	"course_or_station_note" text,
	"notes" text,
	"priority" integer DEFAULT 0 NOT NULL,
	"source_requirement_id" uuid,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "shifts_period_requirement_date_unique" UNIQUE("schedule_period_id","source_requirement_id","shift_date"),
	CONSTRAINT "shifts_end_after_start" CHECK ("shifts"."end_at" > "shifts"."start_at"),
	CONSTRAINT "shifts_required_count_positive" CHECK ("shifts"."required_employee_count" > 0)
);
--> statement-breakpoint
CREATE TABLE "staffing_template_requirements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staffing_template_id" uuid NOT NULL,
	"day_of_week" integer NOT NULL,
	"position_id" uuid NOT NULL,
	"restaurant_area_id" uuid,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"required_employee_count" integer NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staffing_template_requirements_day_of_week_valid" CHECK ("staffing_template_requirements"."day_of_week" BETWEEN 0 AND 6),
	CONSTRAINT "staffing_template_requirements_count_positive" CHECK ("staffing_template_requirements"."required_employee_count" > 0),
	CONSTRAINT "staffing_template_requirements_times_differ" CHECK ("staffing_template_requirements"."start_time" <> "staffing_template_requirements"."end_time")
);
--> statement-breakpoint
CREATE TABLE "staffing_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "staffing_templates_location_id_name_unique" UNIQUE("location_id","name")
);
--> statement-breakpoint
CREATE TABLE "time_off_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"request_type" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"reason" text,
	"employee_note" text,
	"manager_note" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"reviewed_by_user_id" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "time_off_requests_end_after_start" CHECK ("time_off_requests"."end_at" > "time_off_requests"."start_at"),
	CONSTRAINT "time_off_requests_type_valid" CHECK ("time_off_requests"."request_type" IN ('VACATION', 'SICK', 'PERSONAL', 'OTHER')),
	CONSTRAINT "time_off_requests_status_valid" CHECK ("time_off_requests"."status" IN ('PENDING', 'APPROVED', 'DENIED', 'CANCELLED')),
	CONSTRAINT "time_off_requests_review_metadata" CHECK (("time_off_requests"."reviewed_at" IS NULL) = ("time_off_requests"."reviewed_by_user_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "employee_availability" ADD CONSTRAINT "employee_availability_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_availability" ADD CONSTRAINT "employee_availability_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_availability_exceptions" ADD CONSTRAINT "employee_availability_exceptions_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_availability_exceptions" ADD CONSTRAINT "employee_availability_exceptions_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_scheduling_preferences" ADD CONSTRAINT "employee_scheduling_preferences_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_scheduling_preferences" ADD CONSTRAINT "employee_scheduling_preferences_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_generation_runs" ADD CONSTRAINT "schedule_generation_runs_started_by_user_id_users_id_fk" FOREIGN KEY ("started_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_generation_runs" ADD CONSTRAINT "schedule_generation_runs_period_fk" FOREIGN KEY ("schedule_period_id") REFERENCES "public"."schedule_periods"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_periods" ADD CONSTRAINT "schedule_periods_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_periods" ADD CONSTRAINT "schedule_periods_published_by_user_id_users_id_fk" FOREIGN KEY ("published_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_periods" ADD CONSTRAINT "schedule_periods_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduling_rules" ADD CONSTRAINT "scheduling_rules_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_assignments" ADD CONSTRAINT "shift_assignments_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_assignments" ADD CONSTRAINT "shift_assignments_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_assignments" ADD CONSTRAINT "shift_assignments_assigned_by_user_id_users_id_fk" FOREIGN KEY ("assigned_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_assignments" ADD CONSTRAINT "shift_assignments_ended_by_user_id_users_id_fk" FOREIGN KEY ("ended_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_assignments" ADD CONSTRAINT "shift_assignments_generation_run_fk" FOREIGN KEY ("generation_run_id") REFERENCES "public"."schedule_generation_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_swap_requests" ADD CONSTRAINT "shift_swap_requests_requesting_employee_id_employees_id_fk" FOREIGN KEY ("requesting_employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_swap_requests" ADD CONSTRAINT "shift_swap_requests_target_employee_id_employees_id_fk" FOREIGN KEY ("target_employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_swap_requests" ADD CONSTRAINT "shift_swap_requests_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_swap_requests" ADD CONSTRAINT "shift_swap_requests_accepted_by_user_id_users_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_swap_requests" ADD CONSTRAINT "shift_swap_requests_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_swap_requests" ADD CONSTRAINT "shift_swap_requests_denied_by_user_id_users_id_fk" FOREIGN KEY ("denied_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_swap_requests" ADD CONSTRAINT "shift_swap_requests_assignment_fk" FOREIGN KEY ("shift_assignment_id") REFERENCES "public"."shift_assignments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_swap_requests" ADD CONSTRAINT "shift_swap_requests_replacement_fk" FOREIGN KEY ("replacement_assignment_id") REFERENCES "public"."shift_assignments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_restaurant_area_id_restaurant_areas_id_fk" FOREIGN KEY ("restaurant_area_id") REFERENCES "public"."restaurant_areas"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_period_location_fk" FOREIGN KEY ("schedule_period_id","location_id") REFERENCES "public"."schedule_periods"("id","location_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_source_requirement_fk" FOREIGN KEY ("source_requirement_id") REFERENCES "public"."staffing_template_requirements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staffing_template_requirements" ADD CONSTRAINT "staffing_template_requirements_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staffing_template_requirements" ADD CONSTRAINT "staffing_template_requirements_template_fk" FOREIGN KEY ("staffing_template_id") REFERENCES "public"."staffing_templates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staffing_template_requirements" ADD CONSTRAINT "staffing_template_requirements_area_fk" FOREIGN KEY ("restaurant_area_id") REFERENCES "public"."restaurant_areas"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staffing_templates" ADD CONSTRAINT "staffing_templates_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_off_requests" ADD CONSTRAINT "time_off_requests_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_off_requests" ADD CONSTRAINT "time_off_requests_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_off_requests" ADD CONSTRAINT "time_off_requests_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "employee_availability_employee_id_idx" ON "employee_availability" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "employee_availability_exceptions_employee_id_date_idx" ON "employee_availability_exceptions" USING btree ("employee_id","exception_date");--> statement-breakpoint
CREATE INDEX "schedule_generation_runs_schedule_period_id_idx" ON "schedule_generation_runs" USING btree ("schedule_period_id");--> statement-breakpoint
CREATE INDEX "schedule_periods_location_id_start_date_idx" ON "schedule_periods" USING btree ("location_id","start_date");--> statement-breakpoint
CREATE UNIQUE INDEX "shift_assignments_one_active_per_employee_unique" ON "shift_assignments" USING btree ("shift_id","employee_id") WHERE "shift_assignments"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "shift_assignments_employee_id_status_idx" ON "shift_assignments" USING btree ("employee_id","status");--> statement-breakpoint
CREATE INDEX "shift_assignments_shift_id_status_idx" ON "shift_assignments" USING btree ("shift_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "shift_swap_requests_one_open_per_assignment_unique" ON "shift_swap_requests" USING btree ("shift_assignment_id") WHERE "shift_swap_requests"."status" IN ('PENDING', 'ACCEPTED');--> statement-breakpoint
CREATE INDEX "shift_swap_requests_status_idx" ON "shift_swap_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "shifts_schedule_period_id_shift_date_idx" ON "shifts" USING btree ("schedule_period_id","shift_date");--> statement-breakpoint
CREATE INDEX "staffing_template_requirements_template_id_idx" ON "staffing_template_requirements" USING btree ("staffing_template_id");--> statement-breakpoint
CREATE INDEX "time_off_requests_employee_id_start_at_idx" ON "time_off_requests" USING btree ("employee_id","start_at");--> statement-breakpoint
CREATE INDEX "time_off_requests_status_idx" ON "time_off_requests" USING btree ("status");