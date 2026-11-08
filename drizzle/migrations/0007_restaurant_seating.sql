CREATE TABLE "restaurant_tables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"restaurant_area_id" uuid NOT NULL,
	"table_number" text NOT NULL,
	"name" text,
	"capacity" integer NOT NULL,
	"minimum_capacity" integer,
	"condition" text DEFAULT 'CLEAN' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "restaurant_tables_location_id_table_number_unique" UNIQUE("location_id","table_number"),
	CONSTRAINT "restaurant_tables_id_location_id_unique" UNIQUE("id","location_id"),
	CONSTRAINT "restaurant_tables_capacity_positive" CHECK ("restaurant_tables"."capacity" > 0),
	CONSTRAINT "restaurant_tables_minimum_capacity_valid" CHECK ("restaurant_tables"."minimum_capacity" IS NULL OR ("restaurant_tables"."minimum_capacity" > 0 AND "restaurant_tables"."minimum_capacity" <= "restaurant_tables"."capacity")),
	CONSTRAINT "restaurant_tables_condition_valid" CHECK ("restaurant_tables"."condition" IN ('CLEAN', 'DIRTY', 'OUT_OF_SERVICE')),
	CONSTRAINT "restaurant_tables_table_number_not_blank" CHECK (length(trim("restaurant_tables"."table_number")) > 0)
);
--> statement-breakpoint
CREATE TABLE "server_section_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_section_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_to" timestamp with time zone,
	"assigned_by_user_id" uuid NOT NULL,
	"ended_by_user_id" uuid,
	"schedule_override_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "server_section_assignments_effective_range" CHECK ("server_section_assignments"."effective_to" IS NULL OR "server_section_assignments"."effective_to" >= "server_section_assignments"."effective_from"),
	CONSTRAINT "server_section_assignments_ended_metadata" CHECK (("server_section_assignments"."effective_to" IS NULL) = ("server_section_assignments"."ended_by_user_id" IS NULL)),
	CONSTRAINT "server_section_assignments_override_reason_not_blank" CHECK ("server_section_assignments"."schedule_override_reason" IS NULL OR length(trim("server_section_assignments"."schedule_override_reason")) > 0)
);
--> statement-breakpoint
CREATE TABLE "server_section_tables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_section_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"restaurant_table_id" uuid NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_sections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"restaurant_area_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "server_sections_location_id_code_unique" UNIQUE("location_id","code"),
	CONSTRAINT "server_sections_id_location_id_unique" UNIQUE("id","location_id")
);
--> statement-breakpoint
CREATE TABLE "table_condition_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_table_id" uuid NOT NULL,
	"condition" text NOT NULL,
	"reason" text,
	"changed_by_user_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "table_condition_history_condition_valid" CHECK ("table_condition_history"."condition" IN ('CLEAN', 'DIRTY', 'OUT_OF_SERVICE'))
);
--> statement-breakpoint
CREATE TABLE "table_session_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"table_session_id" uuid NOT NULL,
	"override_type" text NOT NULL,
	"reason" text NOT NULL,
	"overridden_by_user_id" uuid NOT NULL,
	"server_employee_id" uuid,
	"party_size" integer,
	"seated_capacity" integer,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "table_session_overrides_type_valid" CHECK ("table_session_overrides"."override_type" IN ('CAPACITY', 'SERVER_SCHEDULE')),
	CONSTRAINT "table_session_overrides_reason_not_blank" CHECK (length(trim("table_session_overrides"."reason")) > 0),
	CONSTRAINT "table_session_overrides_details_match_type" CHECK (("table_session_overrides"."override_type" = 'SERVER_SCHEDULE') = ("table_session_overrides"."server_employee_id" IS NOT NULL) AND ("table_session_overrides"."override_type" = 'CAPACITY') = ("table_session_overrides"."party_size" IS NOT NULL) AND ("table_session_overrides"."party_size" IS NULL) = ("table_session_overrides"."seated_capacity" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "table_session_tables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"table_session_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"restaurant_table_id" uuid NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "table_session_tables_left_after_joined" CHECK ("table_session_tables"."left_at" IS NULL OR "table_session_tables"."left_at" >= "table_session_tables"."joined_at")
);
--> statement-breakpoint
CREATE TABLE "table_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"party_size" integer NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"assigned_server_employee_id" uuid,
	"seated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_by_user_id" uuid NOT NULL,
	"completed_by_user_id" uuid,
	"cancelled_at" timestamp with time zone,
	"cancelled_by_user_id" uuid,
	"cancel_reason" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "table_sessions_id_location_id_unique" UNIQUE("id","location_id"),
	CONSTRAINT "table_sessions_party_size_positive" CHECK ("table_sessions"."party_size" > 0),
	CONSTRAINT "table_sessions_status_valid" CHECK ("table_sessions"."status" IN ('ACTIVE', 'COMPLETED', 'CANCELLED')),
	CONSTRAINT "table_sessions_completed_metadata" CHECK (("table_sessions"."status" = 'COMPLETED') = ("table_sessions"."completed_at" IS NOT NULL) AND ("table_sessions"."completed_at" IS NULL) = ("table_sessions"."completed_by_user_id" IS NULL)),
	CONSTRAINT "table_sessions_cancelled_metadata" CHECK (("table_sessions"."status" = 'CANCELLED') = ("table_sessions"."cancelled_at" IS NOT NULL) AND ("table_sessions"."cancelled_at" IS NULL) = ("table_sessions"."cancelled_by_user_id" IS NULL) AND ("table_sessions"."cancelled_at" IS NULL) = ("table_sessions"."cancel_reason" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "restaurant_tables" ADD CONSTRAINT "restaurant_tables_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restaurant_tables" ADD CONSTRAINT "restaurant_tables_area_location_fk" FOREIGN KEY ("restaurant_area_id","location_id") REFERENCES "public"."restaurant_areas"("id","location_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_section_assignments" ADD CONSTRAINT "server_section_assignments_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_section_assignments" ADD CONSTRAINT "server_section_assignments_assigned_by_user_id_users_id_fk" FOREIGN KEY ("assigned_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_section_assignments" ADD CONSTRAINT "server_section_assignments_ended_by_user_id_users_id_fk" FOREIGN KEY ("ended_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_section_assignments" ADD CONSTRAINT "server_section_assignments_section_fk" FOREIGN KEY ("server_section_id") REFERENCES "public"."server_sections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_section_tables" ADD CONSTRAINT "server_section_tables_section_location_fk" FOREIGN KEY ("server_section_id","location_id") REFERENCES "public"."server_sections"("id","location_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_section_tables" ADD CONSTRAINT "server_section_tables_table_location_fk" FOREIGN KEY ("restaurant_table_id","location_id") REFERENCES "public"."restaurant_tables"("id","location_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_sections" ADD CONSTRAINT "server_sections_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_sections" ADD CONSTRAINT "server_sections_area_location_fk" FOREIGN KEY ("restaurant_area_id","location_id") REFERENCES "public"."restaurant_areas"("id","location_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_condition_history" ADD CONSTRAINT "table_condition_history_changed_by_user_id_users_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_condition_history" ADD CONSTRAINT "table_condition_history_table_fk" FOREIGN KEY ("restaurant_table_id") REFERENCES "public"."restaurant_tables"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_session_overrides" ADD CONSTRAINT "table_session_overrides_table_session_id_table_sessions_id_fk" FOREIGN KEY ("table_session_id") REFERENCES "public"."table_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_session_overrides" ADD CONSTRAINT "table_session_overrides_overridden_by_user_id_users_id_fk" FOREIGN KEY ("overridden_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_session_overrides" ADD CONSTRAINT "table_session_overrides_server_employee_id_employees_id_fk" FOREIGN KEY ("server_employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_session_tables" ADD CONSTRAINT "table_session_tables_session_location_fk" FOREIGN KEY ("table_session_id","location_id") REFERENCES "public"."table_sessions"("id","location_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_session_tables" ADD CONSTRAINT "table_session_tables_table_location_fk" FOREIGN KEY ("restaurant_table_id","location_id") REFERENCES "public"."restaurant_tables"("id","location_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_sessions" ADD CONSTRAINT "table_sessions_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_sessions" ADD CONSTRAINT "table_sessions_assigned_server_employee_id_employees_id_fk" FOREIGN KEY ("assigned_server_employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_sessions" ADD CONSTRAINT "table_sessions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_sessions" ADD CONSTRAINT "table_sessions_completed_by_user_id_users_id_fk" FOREIGN KEY ("completed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_sessions" ADD CONSTRAINT "table_sessions_cancelled_by_user_id_users_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "restaurant_tables_restaurant_area_id_idx" ON "restaurant_tables" USING btree ("restaurant_area_id");--> statement-breakpoint
CREATE UNIQUE INDEX "server_section_assignments_one_open_per_date_unique" ON "server_section_assignments" USING btree ("server_section_id","business_date") WHERE "server_section_assignments"."effective_to" IS NULL;--> statement-breakpoint
CREATE INDEX "server_section_assignments_employee_id_business_date_idx" ON "server_section_assignments" USING btree ("employee_id","business_date");--> statement-breakpoint
CREATE UNIQUE INDEX "server_section_tables_one_active_per_table_unique" ON "server_section_tables" USING btree ("restaurant_table_id") WHERE "server_section_tables"."active";--> statement-breakpoint
CREATE INDEX "server_section_tables_server_section_id_idx" ON "server_section_tables" USING btree ("server_section_id");--> statement-breakpoint
CREATE INDEX "table_condition_history_table_id_occurred_at_idx" ON "table_condition_history" USING btree ("restaurant_table_id","occurred_at");--> statement-breakpoint
CREATE INDEX "table_session_overrides_table_session_id_idx" ON "table_session_overrides" USING btree ("table_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "table_session_tables_one_open_per_table_unique" ON "table_session_tables" USING btree ("restaurant_table_id") WHERE "table_session_tables"."left_at" IS NULL;--> statement-breakpoint
CREATE INDEX "table_session_tables_table_session_id_idx" ON "table_session_tables" USING btree ("table_session_id");--> statement-breakpoint
CREATE INDEX "table_sessions_location_id_status_idx" ON "table_sessions" USING btree ("location_id","status");--> statement-breakpoint
CREATE INDEX "table_sessions_assigned_server_employee_id_idx" ON "table_sessions" USING btree ("assigned_server_employee_id");