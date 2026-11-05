CREATE TABLE "certification_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"expiration_required" boolean DEFAULT false NOT NULL,
	"warning_days" integer,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "certification_types_organization_id_code_unique" UNIQUE("organization_id","code"),
	CONSTRAINT "certification_types_warning_days_not_negative" CHECK ("certification_types"."warning_days" IS NULL OR "certification_types"."warning_days" >= 0)
);
--> statement-breakpoint
CREATE TABLE "employee_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"address_type" text NOT NULL,
	"address_line1" text NOT NULL,
	"address_line2" text,
	"city" text NOT NULL,
	"state" text NOT NULL,
	"postal_code" text NOT NULL,
	"country" text NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employee_addresses_address_type_valid" CHECK ("employee_addresses"."address_type" IN ('HOME', 'MAILING', 'OTHER')),
	CONSTRAINT "employee_addresses_effective_range" CHECK ("employee_addresses"."effective_to" IS NULL OR "employee_addresses"."effective_from" <= "employee_addresses"."effective_to")
);
--> statement-breakpoint
CREATE TABLE "employee_certifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"certification_type_id" uuid NOT NULL,
	"certification_number" text,
	"issued_date" date,
	"expiration_date" date,
	"document_id" uuid,
	"verified" boolean DEFAULT false NOT NULL,
	"verified_by_user_id" uuid,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employee_certifications_verification_complete" CHECK (("employee_certifications"."verified" AND "employee_certifications"."verified_by_user_id" IS NOT NULL AND "employee_certifications"."verified_at" IS NOT NULL)
        OR (NOT "employee_certifications"."verified" AND "employee_certifications"."verified_by_user_id" IS NULL AND "employee_certifications"."verified_at" IS NULL)),
	CONSTRAINT "employee_certifications_issued_not_after_expiration" CHECK ("employee_certifications"."issued_date" IS NULL OR "employee_certifications"."expiration_date" IS NULL OR "employee_certifications"."issued_date" <= "employee_certifications"."expiration_date")
);
--> statement-breakpoint
CREATE TABLE "employee_disciplinary_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"action_type" text NOT NULL,
	"incident_date" date,
	"action_date" date NOT NULL,
	"description" text NOT NULL,
	"action_taken" text NOT NULL,
	"follow_up_date" date,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "employee_disciplinary_actions_action_type_valid" CHECK ("employee_disciplinary_actions"."action_type" IN ('VERBAL_WARNING', 'WRITTEN_WARNING', 'FINAL_WARNING', 'SUSPENSION', 'OTHER')),
	CONSTRAINT "employee_disciplinary_actions_incident_not_after_action" CHECK ("employee_disciplinary_actions"."incident_date" IS NULL OR "employee_disciplinary_actions"."incident_date" <= "employee_disciplinary_actions"."action_date")
);
--> statement-breakpoint
CREATE TABLE "employee_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"document_type" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"storage_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"file_size" integer NOT NULL,
	"sensitive" boolean DEFAULT true NOT NULL,
	"uploaded_by_user_id" uuid NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employee_documents_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "employee_documents_document_type_valid" CHECK ("employee_documents"."document_type" IN ('CONTRACT', 'CERTIFICATION', 'POLICY_ACKNOWLEDGEMENT', 'OTHER')),
	CONSTRAINT "employee_documents_file_size_positive" CHECK ("employee_documents"."file_size" > 0)
);
--> statement-breakpoint
CREATE TABLE "employee_emergency_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"name" text NOT NULL,
	"relationship" text NOT NULL,
	"phone" text NOT NULL,
	"alternate_phone" text,
	"email" text,
	"primary_contact" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employee_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"primary_location" boolean DEFAULT false NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employee_locations_effective_range" CHECK ("employee_locations"."effective_to" IS NULL OR "employee_locations"."effective_from" <= "employee_locations"."effective_to"),
	CONSTRAINT "employee_locations_active_matches_end" CHECK ("employee_locations"."active" = ("employee_locations"."effective_to" IS NULL)),
	CONSTRAINT "employee_locations_primary_is_active" CHECK (NOT "employee_locations"."primary_location" OR "employee_locations"."active")
);
--> statement-breakpoint
CREATE TABLE "employee_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"note_type" text NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"sensitive" boolean DEFAULT false NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "employee_notes_note_type_valid" CHECK ("employee_notes"."note_type" IN ('GENERAL', 'PERFORMANCE', 'RECOGNITION', 'TRAINING', 'MANAGER'))
);
--> statement-breakpoint
CREATE TABLE "employee_performance_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"reviewer_employee_id" uuid,
	"reviewer_user_id" uuid,
	"review_period_start" date NOT NULL,
	"review_period_end" date NOT NULL,
	"review_date" date NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"overall_rating" integer,
	"summary" text,
	"employee_comments" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "employee_performance_reviews_status_valid" CHECK ("employee_performance_reviews"."status" IN ('DRAFT', 'COMPLETED')),
	CONSTRAINT "employee_performance_reviews_rating_range" CHECK ("employee_performance_reviews"."overall_rating" IS NULL OR "employee_performance_reviews"."overall_rating" BETWEEN 1 AND 5),
	CONSTRAINT "employee_performance_reviews_period_range" CHECK ("employee_performance_reviews"."review_period_start" <= "employee_performance_reviews"."review_period_end")
);
--> statement-breakpoint
CREATE TABLE "employee_position_compensation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"position_id" uuid NOT NULL,
	"compensation_type" text NOT NULL,
	"hourly_rate" numeric(12, 2),
	"annual_salary" numeric(12, 2),
	"effective_from" date NOT NULL,
	"effective_to" date,
	"change_reason" text,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employee_position_compensation_amount_matches_type" CHECK (("employee_position_compensation"."compensation_type" = 'HOURLY' AND "employee_position_compensation"."hourly_rate" IS NOT NULL AND "employee_position_compensation"."hourly_rate" >= 0 AND "employee_position_compensation"."annual_salary" IS NULL)
        OR ("employee_position_compensation"."compensation_type" = 'SALARY' AND "employee_position_compensation"."annual_salary" IS NOT NULL AND "employee_position_compensation"."annual_salary" >= 0 AND "employee_position_compensation"."hourly_rate" IS NULL)),
	CONSTRAINT "employee_position_compensation_effective_range" CHECK ("employee_position_compensation"."effective_to" IS NULL OR "employee_position_compensation"."effective_from" <= "employee_position_compensation"."effective_to")
);
--> statement-breakpoint
CREATE TABLE "employee_positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"position_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"primary_position" boolean DEFAULT false NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employee_positions_effective_range" CHECK ("employee_positions"."effective_to" IS NULL OR "employee_positions"."effective_from" <= "employee_positions"."effective_to"),
	CONSTRAINT "employee_positions_active_matches_end" CHECK ("employee_positions"."active" = ("employee_positions"."effective_to" IS NULL)),
	CONSTRAINT "employee_positions_primary_is_active" CHECK (NOT "employee_positions"."primary_position" OR "employee_positions"."active")
);
--> statement-breakpoint
CREATE TABLE "employee_status_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"status" text NOT NULL,
	"effective_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" text,
	"changed_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employee_status_history_status_valid" CHECK ("employee_status_history"."status" IN ('ACTIVE', 'ON_LEAVE', 'SUSPENDED', 'TERMINATED'))
);
--> statement-breakpoint
CREATE TABLE "employees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid,
	"employee_number" text NOT NULL,
	"first_name" text NOT NULL,
	"middle_name" text,
	"last_name" text NOT NULL,
	"preferred_name" text,
	"personal_email" text,
	"work_email" text,
	"phone" text,
	"hire_date" date NOT NULL,
	"termination_date" date,
	"employment_status" text DEFAULT 'ACTIVE' NOT NULL,
	"employment_type" text NOT NULL,
	"primary_location_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "employees_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "employees_organization_id_employee_number_unique" UNIQUE("organization_id","employee_number"),
	CONSTRAINT "employees_id_organization_id_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "employees_employment_status_valid" CHECK ("employees"."employment_status" IN ('ACTIVE', 'ON_LEAVE', 'SUSPENDED', 'TERMINATED')),
	CONSTRAINT "employees_employment_type_valid" CHECK ("employees"."employment_type" IN ('FULL_TIME', 'PART_TIME', 'SEASONAL', 'TEMPORARY')),
	CONSTRAINT "employees_terminated_matches_termination_date" CHECK (("employees"."employment_status" = 'TERMINATED') = ("employees"."termination_date" IS NOT NULL)),
	CONSTRAINT "employees_hire_not_after_termination" CHECK ("employees"."termination_date" IS NULL OR "employees"."hire_date" <= "employees"."termination_date")
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "positions_organization_id_code_unique" UNIQUE("organization_id","code"),
	CONSTRAINT "positions_id_organization_id_unique" UNIQUE("id","organization_id")
);
--> statement-breakpoint
ALTER TABLE "certification_types" ADD CONSTRAINT "certification_types_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_addresses" ADD CONSTRAINT "employee_addresses_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_certifications" ADD CONSTRAINT "employee_certifications_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_certifications" ADD CONSTRAINT "employee_certifications_document_id_employee_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."employee_documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_certifications" ADD CONSTRAINT "employee_certifications_verified_by_user_id_users_id_fk" FOREIGN KEY ("verified_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_certifications" ADD CONSTRAINT "employee_certifications_certification_type_fk" FOREIGN KEY ("certification_type_id") REFERENCES "public"."certification_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_disciplinary_actions" ADD CONSTRAINT "employee_disciplinary_actions_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_disciplinary_actions" ADD CONSTRAINT "employee_disciplinary_actions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_documents" ADD CONSTRAINT "employee_documents_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_documents" ADD CONSTRAINT "employee_documents_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_emergency_contacts" ADD CONSTRAINT "employee_emergency_contacts_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_locations" ADD CONSTRAINT "employee_locations_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_locations" ADD CONSTRAINT "employee_locations_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_notes" ADD CONSTRAINT "employee_notes_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_notes" ADD CONSTRAINT "employee_notes_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_performance_reviews" ADD CONSTRAINT "employee_performance_reviews_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_performance_reviews" ADD CONSTRAINT "employee_performance_reviews_reviewer_user_id_users_id_fk" FOREIGN KEY ("reviewer_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_performance_reviews" ADD CONSTRAINT "employee_performance_reviews_reviewer_employee_fk" FOREIGN KEY ("reviewer_employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_position_compensation" ADD CONSTRAINT "employee_position_compensation_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_position_compensation" ADD CONSTRAINT "employee_position_compensation_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_position_compensation" ADD CONSTRAINT "employee_position_compensation_employee_fk" FOREIGN KEY ("employee_id","organization_id") REFERENCES "public"."employees"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_position_compensation" ADD CONSTRAINT "employee_position_compensation_position_fk" FOREIGN KEY ("position_id","organization_id") REFERENCES "public"."positions"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_positions" ADD CONSTRAINT "employee_positions_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_positions" ADD CONSTRAINT "employee_positions_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_positions" ADD CONSTRAINT "employee_positions_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_status_history" ADD CONSTRAINT "employee_status_history_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_status_history" ADD CONSTRAINT "employee_status_history_changed_by_user_id_users_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_primary_location_id_locations_id_fk" FOREIGN KEY ("primary_location_id") REFERENCES "public"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "employee_addresses_one_open_per_type_unique" ON "employee_addresses" USING btree ("employee_id","address_type") WHERE "employee_addresses"."effective_to" IS NULL;--> statement-breakpoint
CREATE INDEX "employee_addresses_employee_id_idx" ON "employee_addresses" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "employee_certifications_employee_id_idx" ON "employee_certifications" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "employee_certifications_certification_type_id_idx" ON "employee_certifications" USING btree ("certification_type_id");--> statement-breakpoint
CREATE INDEX "employee_certifications_expiration_date_idx" ON "employee_certifications" USING btree ("expiration_date");--> statement-breakpoint
CREATE INDEX "employee_disciplinary_actions_employee_id_idx" ON "employee_disciplinary_actions" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "employee_documents_employee_id_idx" ON "employee_documents" USING btree ("employee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "employee_emergency_contacts_one_primary_unique" ON "employee_emergency_contacts" USING btree ("employee_id") WHERE "employee_emergency_contacts"."primary_contact";--> statement-breakpoint
CREATE INDEX "employee_emergency_contacts_employee_id_idx" ON "employee_emergency_contacts" USING btree ("employee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "employee_locations_one_active_primary_unique" ON "employee_locations" USING btree ("employee_id") WHERE "employee_locations"."primary_location" AND "employee_locations"."active";--> statement-breakpoint
CREATE INDEX "employee_locations_location_id_employee_id_idx" ON "employee_locations" USING btree ("location_id","employee_id");--> statement-breakpoint
CREATE INDEX "employee_locations_employee_id_idx" ON "employee_locations" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "employee_notes_employee_id_idx" ON "employee_notes" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "employee_performance_reviews_employee_id_idx" ON "employee_performance_reviews" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "employee_performance_reviews_reviewer_employee_id_idx" ON "employee_performance_reviews" USING btree ("reviewer_employee_id");--> statement-breakpoint
CREATE INDEX "employee_position_compensation_employee_position_idx" ON "employee_position_compensation" USING btree ("employee_id","position_id","effective_from");--> statement-breakpoint
CREATE INDEX "employee_position_compensation_position_id_idx" ON "employee_position_compensation" USING btree ("position_id");--> statement-breakpoint
CREATE UNIQUE INDEX "employee_positions_one_active_primary_unique" ON "employee_positions" USING btree ("employee_id","location_id") WHERE "employee_positions"."primary_position" AND "employee_positions"."active";--> statement-breakpoint
CREATE INDEX "employee_positions_employee_id_position_id_idx" ON "employee_positions" USING btree ("employee_id","position_id");--> statement-breakpoint
CREATE INDEX "employee_positions_position_id_idx" ON "employee_positions" USING btree ("position_id");--> statement-breakpoint
CREATE INDEX "employee_positions_location_id_idx" ON "employee_positions" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "employee_status_history_employee_id_effective_at_idx" ON "employee_status_history" USING btree ("employee_id","effective_at");