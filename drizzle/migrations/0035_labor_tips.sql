CREATE TABLE "time_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"position_id" uuid NOT NULL,
	"shift_assignment_id" uuid,
	"business_date" date NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"clock_in_at" timestamp with time zone NOT NULL,
	"clock_out_at" timestamp with time zone,
	"clock_in_recorded_at" timestamp with time zone NOT NULL,
	"clock_out_recorded_at" timestamp with time zone,
	"clock_in_source" text NOT NULL,
	"clock_out_source" text,
	"clock_in_by_user_id" uuid NOT NULL,
	"clock_out_by_user_id" uuid,
	"clock_in_idempotency_record_id" uuid NOT NULL,
	"voided_by_user_id" uuid,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "time_entries_status_valid" CHECK ("time_entries"."status" IN ('OPEN', 'CLOSED', 'VOIDED')),
	CONSTRAINT "time_entries_sources_valid" CHECK ("time_entries"."clock_in_source" IN ('SELF', 'MANAGER')
        AND ("time_entries"."clock_out_source" IS NULL OR "time_entries"."clock_out_source" IN ('SELF', 'MANAGER', 'ADJUSTMENT'))),
	CONSTRAINT "time_entries_clock_out_fields" CHECK (("time_entries"."clock_out_at" IS NULL) = ("time_entries"."clock_out_source" IS NULL)
        AND ("time_entries"."clock_out_at" IS NULL) = ("time_entries"."clock_out_by_user_id" IS NULL)
        AND ("time_entries"."clock_out_recorded_at" IS NULL) = ("time_entries"."clock_out_source" IS NULL OR "time_entries"."clock_out_source" = 'ADJUSTMENT')
        AND ("time_entries"."status" <> 'OPEN' OR "time_entries"."clock_out_at" IS NULL)
        AND ("time_entries"."status" <> 'CLOSED' OR "time_entries"."clock_out_at" IS NOT NULL)),
	CONSTRAINT "time_entries_clock_out_after_in" CHECK ("time_entries"."clock_out_at" IS NULL OR "time_entries"."clock_out_at" > "time_entries"."clock_in_at"),
	CONSTRAINT "time_entries_void_fields" CHECK (("time_entries"."status" = 'VOIDED') = ("time_entries"."voided_at" IS NOT NULL)
        AND ("time_entries"."voided_at" IS NULL) = ("time_entries"."voided_by_user_id" IS NULL)
        AND ("time_entries"."voided_at" IS NULL) = ("time_entries"."void_reason" IS NULL)
        AND ("time_entries"."void_reason" IS NULL OR (length(trim("time_entries"."void_reason")) > 0 AND "time_entries"."void_reason" !~ '[0-9]{13,}')))
);
--> statement-breakpoint
CREATE TABLE "time_entry_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"time_entry_id" uuid NOT NULL,
	"adjusted_by_user_id" uuid NOT NULL,
	"adjusted_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"changes" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "time_entry_adjustments_reason" CHECK (length(trim("time_entry_adjustments"."reason")) > 0 AND "time_entry_adjustments"."reason" !~ '[0-9]{13,}')
);
--> statement-breakpoint
CREATE TABLE "time_entry_breaks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"time_entry_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"paid" boolean DEFAULT false NOT NULL,
	"recorded_by_user_id" uuid NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "time_entry_breaks_end_after_start" CHECK ("time_entry_breaks"."ended_at" IS NULL OR "time_entry_breaks"."ended_at" > "time_entry_breaks"."started_at"),
	CONSTRAINT "time_entry_breaks_removed_fields" CHECK (("time_entry_breaks"."removed_at" IS NULL) = ("time_entry_breaks"."removed_by_user_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "tip_distribution_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"distribution_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"position_id" uuid NOT NULL,
	"position_code_snapshot" text NOT NULL,
	"worked_hours" numeric(10, 4) NOT NULL,
	"points" numeric(6, 2) NOT NULL,
	"weighted_hours" numeric(10, 4) NOT NULL,
	"share" numeric(12, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tip_distribution_lines_employee_position_unique" UNIQUE("distribution_id","employee_id","position_id"),
	CONSTRAINT "tip_distribution_lines_values" CHECK ("tip_distribution_lines"."worked_hours" > 0 AND "tip_distribution_lines"."points" > 0 AND "tip_distribution_lines"."weighted_hours" > 0 AND "tip_distribution_lines"."share" >= 0)
);
--> statement-breakpoint
CREATE TABLE "tip_distributions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"status" text DEFAULT 'FINALIZED' NOT NULL,
	"pool_total" numeric(12, 2) NOT NULL,
	"cash_tips" numeric(12, 2) NOT NULL,
	"card_tips" numeric(12, 2) NOT NULL,
	"total_weighted_hours" numeric(10, 4) NOT NULL,
	"rule_snapshot" jsonb NOT NULL,
	"finalized_by_user_id" uuid NOT NULL,
	"finalized_at" timestamp with time zone NOT NULL,
	"idempotency_record_id" uuid NOT NULL,
	"voided_by_user_id" uuid,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "tip_distributions_status_valid" CHECK ("tip_distributions"."status" IN ('FINALIZED', 'VOIDED')),
	CONSTRAINT "tip_distributions_amounts" CHECK ("tip_distributions"."cash_tips" >= 0 AND "tip_distributions"."card_tips" >= 0
        AND "tip_distributions"."pool_total" = "tip_distributions"."cash_tips" + "tip_distributions"."card_tips"
        AND "tip_distributions"."total_weighted_hours" >= 0),
	CONSTRAINT "tip_distributions_void_fields" CHECK (("tip_distributions"."status" = 'VOIDED') = ("tip_distributions"."voided_at" IS NOT NULL)
        AND ("tip_distributions"."voided_at" IS NULL) = ("tip_distributions"."voided_by_user_id" IS NULL)
        AND ("tip_distributions"."voided_at" IS NULL) = ("tip_distributions"."void_reason" IS NULL)
        AND ("tip_distributions"."void_reason" IS NULL OR (length(trim("tip_distributions"."void_reason")) > 0 AND "tip_distributions"."void_reason" !~ '[0-9]{13,}')))
);
--> statement-breakpoint
CREATE TABLE "tip_pool_rule_positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rule_id" uuid NOT NULL,
	"position_id" uuid NOT NULL,
	"points" numeric(6, 2) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tip_pool_rule_positions_rule_position_unique" UNIQUE("rule_id","position_id"),
	CONSTRAINT "tip_pool_rule_positions_points_positive" CHECK ("tip_pool_rule_positions"."points" > 0)
);
--> statement-breakpoint
CREATE TABLE "tip_pool_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"name" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "tip_pool_rules_location_id_unique" UNIQUE("location_id"),
	CONSTRAINT "tip_pool_rules_name" CHECK ("tip_pool_rules"."name" IS NULL OR length(trim("tip_pool_rules"."name")) > 0)
);
--> statement-breakpoint
ALTER TABLE "scheduling_rules" ADD COLUMN "overtime_multiplier" numeric(4, 2) DEFAULT '1.50' NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduling_rules" ADD COLUMN "late_clock_in_grace_minutes" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_shift_assignment_id_shift_assignments_id_fk" FOREIGN KEY ("shift_assignment_id") REFERENCES "public"."shift_assignments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_clock_in_by_user_id_users_id_fk" FOREIGN KEY ("clock_in_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_clock_out_by_user_id_users_id_fk" FOREIGN KEY ("clock_out_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_voided_by_user_id_users_id_fk" FOREIGN KEY ("voided_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_location_org_fk" FOREIGN KEY ("location_id","organization_id") REFERENCES "public"."locations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_clock_in_idempotency_fk" FOREIGN KEY ("clock_in_idempotency_record_id") REFERENCES "public"."idempotency_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entry_adjustments" ADD CONSTRAINT "time_entry_adjustments_time_entry_id_time_entries_id_fk" FOREIGN KEY ("time_entry_id") REFERENCES "public"."time_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entry_adjustments" ADD CONSTRAINT "time_entry_adjustments_adjusted_by_user_id_users_id_fk" FOREIGN KEY ("adjusted_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entry_breaks" ADD CONSTRAINT "time_entry_breaks_time_entry_id_time_entries_id_fk" FOREIGN KEY ("time_entry_id") REFERENCES "public"."time_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entry_breaks" ADD CONSTRAINT "time_entry_breaks_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entry_breaks" ADD CONSTRAINT "time_entry_breaks_removed_by_user_id_users_id_fk" FOREIGN KEY ("removed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_distribution_lines" ADD CONSTRAINT "tip_distribution_lines_distribution_id_tip_distributions_id_fk" FOREIGN KEY ("distribution_id") REFERENCES "public"."tip_distributions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_distribution_lines" ADD CONSTRAINT "tip_distribution_lines_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_distribution_lines" ADD CONSTRAINT "tip_distribution_lines_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_distributions" ADD CONSTRAINT "tip_distributions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_distributions" ADD CONSTRAINT "tip_distributions_finalized_by_user_id_users_id_fk" FOREIGN KEY ("finalized_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_distributions" ADD CONSTRAINT "tip_distributions_voided_by_user_id_users_id_fk" FOREIGN KEY ("voided_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_distributions" ADD CONSTRAINT "tip_distributions_location_org_fk" FOREIGN KEY ("location_id","organization_id") REFERENCES "public"."locations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_distributions" ADD CONSTRAINT "tip_distributions_idempotency_fk" FOREIGN KEY ("idempotency_record_id") REFERENCES "public"."idempotency_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_pool_rule_positions" ADD CONSTRAINT "tip_pool_rule_positions_rule_id_tip_pool_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."tip_pool_rules"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_pool_rule_positions" ADD CONSTRAINT "tip_pool_rule_positions_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_pool_rules" ADD CONSTRAINT "tip_pool_rules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_pool_rules" ADD CONSTRAINT "tip_pool_rules_location_org_fk" FOREIGN KEY ("location_id","organization_id") REFERENCES "public"."locations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "time_entries_clock_in_idempotency_unique" ON "time_entries" USING btree ("clock_in_idempotency_record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "time_entries_one_open_per_employee" ON "time_entries" USING btree ("employee_id") WHERE "time_entries"."status" = 'OPEN';--> statement-breakpoint
CREATE INDEX "time_entries_location_date_idx" ON "time_entries" USING btree ("location_id","business_date");--> statement-breakpoint
CREATE INDEX "time_entries_employee_date_idx" ON "time_entries" USING btree ("employee_id","business_date");--> statement-breakpoint
CREATE INDEX "time_entries_shift_assignment_idx" ON "time_entries" USING btree ("shift_assignment_id");--> statement-breakpoint
CREATE INDEX "time_entry_adjustments_entry_idx" ON "time_entry_adjustments" USING btree ("time_entry_id","adjusted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "time_entry_breaks_one_open_per_entry" ON "time_entry_breaks" USING btree ("time_entry_id") WHERE "time_entry_breaks"."ended_at" IS NULL AND "time_entry_breaks"."removed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "time_entry_breaks_entry_idx" ON "time_entry_breaks" USING btree ("time_entry_id");--> statement-breakpoint
CREATE INDEX "tip_distribution_lines_employee_idx" ON "tip_distribution_lines" USING btree ("employee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tip_distributions_idempotency_unique" ON "tip_distributions" USING btree ("idempotency_record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tip_distributions_one_finalized_per_date" ON "tip_distributions" USING btree ("location_id","business_date") WHERE "tip_distributions"."status" = 'FINALIZED';--> statement-breakpoint
CREATE INDEX "tip_distributions_location_date_idx" ON "tip_distributions" USING btree ("location_id","business_date");--> statement-breakpoint
ALTER TABLE "scheduling_rules" ADD CONSTRAINT "scheduling_rules_overtime_multiplier_valid" CHECK ("scheduling_rules"."overtime_multiplier" BETWEEN 1.00 AND 3.00);--> statement-breakpoint
ALTER TABLE "scheduling_rules" ADD CONSTRAINT "scheduling_rules_late_grace_valid" CHECK ("scheduling_rules"."late_clock_in_grace_minutes" BETWEEN 0 AND 120);