CREATE TABLE "manager_log_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"entry_number" integer NOT NULL,
	"business_date" date NOT NULL,
	"category" text NOT NULL,
	"body" text NOT NULL,
	"author_user_id" uuid NOT NULL,
	"author_employee_id" uuid,
	"corrects_entry_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"redacted_at" timestamp with time zone,
	"redacted_by_user_id" uuid,
	"redaction_reason" text,
	CONSTRAINT "manager_log_entries_id_org_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "manager_log_entries_org_number_unique" UNIQUE("organization_id","entry_number"),
	CONSTRAINT "manager_log_entries_number_positive" CHECK ("manager_log_entries"."entry_number" > 0),
	CONSTRAINT "manager_log_entries_category_valid" CHECK ("manager_log_entries"."category" IN ('SERVICE', 'INCIDENT', 'MAINTENANCE', 'STAFFING', 'GUEST', 'OTHER')),
	CONSTRAINT "manager_log_entries_not_self" CHECK ("manager_log_entries"."corrects_entry_id" IS NULL OR "manager_log_entries"."corrects_entry_id" <> "manager_log_entries"."id"),
	CONSTRAINT "manager_log_entries_body_or_redaction" CHECK (("manager_log_entries"."redacted_at" IS NULL AND "manager_log_entries"."redacted_by_user_id" IS NULL AND "manager_log_entries"."redaction_reason" IS NULL
          AND char_length("manager_log_entries"."body") BETWEEN 1 AND 4000)
        OR ("manager_log_entries"."redacted_at" IS NOT NULL AND "manager_log_entries"."redacted_by_user_id" IS NOT NULL
          AND char_length("manager_log_entries"."redaction_reason") BETWEEN 1 AND 500 AND "manager_log_entries"."body" = ''))
);
--> statement-breakpoint
CREATE TABLE "manager_log_number_counters" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"last_number" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "manager_log_number_counters_non_negative" CHECK ("manager_log_number_counters"."last_number" >= 0)
);
--> statement-breakpoint
CREATE TABLE "pre_shift_note_positions" (
	"note_id" uuid NOT NULL,
	"position_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	CONSTRAINT "pre_shift_note_positions_pk" PRIMARY KEY("note_id","position_id")
);
--> statement-breakpoint
CREATE TABLE "pre_shift_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"updated_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "pre_shift_notes_id_org_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "pre_shift_notes_title_length" CHECK (char_length("pre_shift_notes"."title") BETWEEN 1 AND 120),
	CONSTRAINT "pre_shift_notes_body_length" CHECK (char_length("pre_shift_notes"."body") BETWEEN 1 AND 2000)
);
--> statement-breakpoint
ALTER TABLE "manager_log_entries" ADD CONSTRAINT "manager_log_entries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manager_log_entries" ADD CONSTRAINT "manager_log_entries_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manager_log_entries" ADD CONSTRAINT "manager_log_entries_author_employee_id_employees_id_fk" FOREIGN KEY ("author_employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manager_log_entries" ADD CONSTRAINT "manager_log_entries_redacted_by_user_id_users_id_fk" FOREIGN KEY ("redacted_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manager_log_entries" ADD CONSTRAINT "manager_log_entries_location_org_fk" FOREIGN KEY ("location_id","organization_id") REFERENCES "public"."locations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manager_log_entries" ADD CONSTRAINT "manager_log_entries_corrects_fk" FOREIGN KEY ("corrects_entry_id","organization_id") REFERENCES "public"."manager_log_entries"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manager_log_number_counters" ADD CONSTRAINT "manager_log_number_counters_org_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pre_shift_note_positions" ADD CONSTRAINT "pre_shift_note_positions_note_fk" FOREIGN KEY ("note_id","organization_id") REFERENCES "public"."pre_shift_notes"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pre_shift_note_positions" ADD CONSTRAINT "pre_shift_note_positions_position_fk" FOREIGN KEY ("position_id","organization_id") REFERENCES "public"."positions"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pre_shift_notes" ADD CONSTRAINT "pre_shift_notes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pre_shift_notes" ADD CONSTRAINT "pre_shift_notes_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pre_shift_notes" ADD CONSTRAINT "pre_shift_notes_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pre_shift_notes" ADD CONSTRAINT "pre_shift_notes_location_org_fk" FOREIGN KEY ("location_id","organization_id") REFERENCES "public"."locations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "manager_log_entries_location_date_idx" ON "manager_log_entries" USING btree ("location_id","business_date","created_at");--> statement-breakpoint
CREATE INDEX "manager_log_entries_corrects_idx" ON "manager_log_entries" USING btree ("corrects_entry_id");--> statement-breakpoint
CREATE INDEX "pre_shift_note_positions_position_idx" ON "pre_shift_note_positions" USING btree ("position_id");--> statement-breakpoint
CREATE INDEX "pre_shift_notes_location_date_idx" ON "pre_shift_notes" USING btree ("location_id","business_date");