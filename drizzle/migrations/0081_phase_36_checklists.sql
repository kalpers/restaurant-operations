CREATE TABLE "checklist_run_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"template_item_id" uuid NOT NULL,
	"text_snapshot" text NOT NULL,
	"required" boolean NOT NULL,
	"sort_order" integer NOT NULL,
	"state" text DEFAULT 'OPEN' NOT NULL,
	"acted_by_user_id" uuid,
	"acted_at" timestamp with time zone,
	"skip_reason" text,
	"note" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "checklist_run_items_run_template_item_unique" UNIQUE("run_id","template_item_id"),
	CONSTRAINT "checklist_run_items_state_valid" CHECK ("checklist_run_items"."state" IN ('OPEN', 'DONE', 'SKIPPED')),
	CONSTRAINT "checklist_run_items_state_recorded" CHECK (("checklist_run_items"."state" = 'OPEN' AND "checklist_run_items"."acted_at" IS NULL AND "checklist_run_items"."acted_by_user_id" IS NULL AND "checklist_run_items"."skip_reason" IS NULL)
        OR ("checklist_run_items"."state" = 'DONE' AND "checklist_run_items"."acted_at" IS NOT NULL AND "checklist_run_items"."acted_by_user_id" IS NOT NULL AND "checklist_run_items"."skip_reason" IS NULL)
        OR ("checklist_run_items"."state" = 'SKIPPED' AND "checklist_run_items"."acted_at" IS NOT NULL AND "checklist_run_items"."acted_by_user_id" IS NOT NULL
          AND char_length("checklist_run_items"."skip_reason") BETWEEN 1 AND 200)),
	CONSTRAINT "checklist_run_items_note_length" CHECK ("checklist_run_items"."note" IS NULL OR char_length("checklist_run_items"."note") BETWEEN 1 AND 500),
	CONSTRAINT "checklist_run_items_no_card_digits" CHECK (coalesce("checklist_run_items"."note", '') !~ '[0-9]{13,}' AND coalesce("checklist_run_items"."skip_reason", '') !~ '[0-9]{13,}')
);
--> statement-breakpoint
CREATE TABLE "checklist_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"kind" text NOT NULL,
	"template_name_snapshot" text NOT NULL,
	"requires_sign_off" boolean NOT NULL,
	"employee_id" uuid,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"started_by_user_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_by_user_id" uuid,
	"completed_at" timestamp with time zone,
	"signed_off_by_user_id" uuid,
	"signed_off_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "checklist_runs_id_org_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "checklist_runs_kind_valid" CHECK ("checklist_runs"."kind" IN ('OPENING', 'CLOSING', 'SIDE_WORK', 'OTHER')),
	CONSTRAINT "checklist_runs_status_valid" CHECK ("checklist_runs"."status" IN ('OPEN', 'COMPLETED')),
	CONSTRAINT "checklist_runs_employee_for_side_work" CHECK (("checklist_runs"."kind" = 'SIDE_WORK') = ("checklist_runs"."employee_id" IS NOT NULL)),
	CONSTRAINT "checklist_runs_completion_recorded" CHECK (("checklist_runs"."status" = 'OPEN' AND "checklist_runs"."completed_at" IS NULL AND "checklist_runs"."completed_by_user_id" IS NULL)
        OR ("checklist_runs"."status" = 'COMPLETED' AND "checklist_runs"."completed_at" IS NOT NULL AND "checklist_runs"."completed_by_user_id" IS NOT NULL)),
	CONSTRAINT "checklist_runs_sign_off_recorded" CHECK (("checklist_runs"."signed_off_at" IS NULL AND "checklist_runs"."signed_off_by_user_id" IS NULL)
        OR ("checklist_runs"."signed_off_at" IS NOT NULL AND "checklist_runs"."signed_off_by_user_id" IS NOT NULL
          AND "checklist_runs"."status" = 'COMPLETED' AND "checklist_runs"."requires_sign_off"
          AND "checklist_runs"."signed_off_by_user_id" <> "checklist_runs"."completed_by_user_id"))
);
--> statement-breakpoint
CREATE TABLE "checklist_template_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"text" text NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "checklist_template_items_text_length" CHECK (char_length("checklist_template_items"."text") BETWEEN 1 AND 200),
	CONSTRAINT "checklist_template_items_sort_valid" CHECK ("checklist_template_items"."sort_order" BETWEEN 0 AND 10000)
);
--> statement-breakpoint
CREATE TABLE "checklist_template_positions" (
	"template_id" uuid NOT NULL,
	"position_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	CONSTRAINT "checklist_template_positions_pk" PRIMARY KEY("template_id","position_id")
);
--> statement-breakpoint
CREATE TABLE "checklist_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"requires_sign_off" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by_user_id" uuid,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "checklist_templates_id_org_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "checklist_templates_id_location_unique" UNIQUE("id","location_id"),
	CONSTRAINT "checklist_templates_name_length" CHECK (char_length("checklist_templates"."name") BETWEEN 1 AND 80),
	CONSTRAINT "checklist_templates_kind_valid" CHECK ("checklist_templates"."kind" IN ('OPENING', 'CLOSING', 'SIDE_WORK', 'OTHER'))
);
--> statement-breakpoint
ALTER TABLE "free_text_redactions" DROP CONSTRAINT "free_text_redactions_table_valid";--> statement-breakpoint
ALTER TABLE "checklist_run_items" ADD CONSTRAINT "checklist_run_items_acted_by_user_id_users_id_fk" FOREIGN KEY ("acted_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_run_items" ADD CONSTRAINT "checklist_run_items_run_fk" FOREIGN KEY ("run_id","organization_id") REFERENCES "public"."checklist_runs"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_run_items" ADD CONSTRAINT "checklist_run_items_template_item_fk" FOREIGN KEY ("template_item_id") REFERENCES "public"."checklist_template_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_runs" ADD CONSTRAINT "checklist_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_runs" ADD CONSTRAINT "checklist_runs_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_runs" ADD CONSTRAINT "checklist_runs_started_by_user_id_users_id_fk" FOREIGN KEY ("started_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_runs" ADD CONSTRAINT "checklist_runs_completed_by_user_id_users_id_fk" FOREIGN KEY ("completed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_runs" ADD CONSTRAINT "checklist_runs_signed_off_by_user_id_users_id_fk" FOREIGN KEY ("signed_off_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_runs" ADD CONSTRAINT "checklist_runs_template_location_fk" FOREIGN KEY ("template_id","location_id") REFERENCES "public"."checklist_templates"("id","location_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_runs" ADD CONSTRAINT "checklist_runs_location_org_fk" FOREIGN KEY ("location_id","organization_id") REFERENCES "public"."locations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_template_items" ADD CONSTRAINT "checklist_template_items_template_fk" FOREIGN KEY ("template_id","organization_id") REFERENCES "public"."checklist_templates"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_template_positions" ADD CONSTRAINT "checklist_template_positions_template_fk" FOREIGN KEY ("template_id","organization_id") REFERENCES "public"."checklist_templates"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_template_positions" ADD CONSTRAINT "checklist_template_positions_position_fk" FOREIGN KEY ("position_id","organization_id") REFERENCES "public"."positions"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_templates" ADD CONSTRAINT "checklist_templates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_templates" ADD CONSTRAINT "checklist_templates_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_templates" ADD CONSTRAINT "checklist_templates_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_templates" ADD CONSTRAINT "checklist_templates_location_org_fk" FOREIGN KEY ("location_id","organization_id") REFERENCES "public"."locations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "checklist_run_items_run_idx" ON "checklist_run_items" USING btree ("run_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "checklist_runs_template_date_unique" ON "checklist_runs" USING btree ("template_id","business_date") WHERE "checklist_runs"."employee_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "checklist_runs_template_date_employee_unique" ON "checklist_runs" USING btree ("template_id","business_date","employee_id") WHERE "checklist_runs"."employee_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "checklist_runs_location_date_idx" ON "checklist_runs" USING btree ("location_id","business_date");--> statement-breakpoint
CREATE INDEX "checklist_template_items_template_idx" ON "checklist_template_items" USING btree ("template_id","sort_order");--> statement-breakpoint
CREATE INDEX "checklist_template_positions_position_idx" ON "checklist_template_positions" USING btree ("position_id");--> statement-breakpoint
CREATE INDEX "checklist_templates_location_idx" ON "checklist_templates" USING btree ("location_id","active");--> statement-breakpoint
ALTER TABLE "free_text_redactions" ADD CONSTRAINT "free_text_redactions_table_valid" CHECK ("free_text_redactions"."table_name" IN ('guest_parties', 'reservations', 'waitlist_entries', 'table_sessions', 'orders', 'order_items', 'kitchen_ticket_items', 'shifts', 'shift_assignments', 'gift_card_purchasers', 'checklist_run_items'));