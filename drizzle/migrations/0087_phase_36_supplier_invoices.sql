CREATE TABLE "supplier_invoice_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"line_kind" text NOT NULL,
	"receipt_line_id" uuid,
	"holds_receipt_line" boolean DEFAULT true NOT NULL,
	"description" text,
	"quantity" numeric(14, 4),
	"unit_price" numeric(14, 4),
	"amount" numeric(12, 2) NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_invoice_lines_kind_valid" CHECK ("supplier_invoice_lines"."line_kind" IN ('ITEM', 'FREIGHT', 'TAX', 'OTHER', 'CREDIT')),
	CONSTRAINT "supplier_invoice_lines_shape" CHECK (("supplier_invoice_lines"."line_kind" = 'ITEM' AND "supplier_invoice_lines"."receipt_line_id" IS NOT NULL AND "supplier_invoice_lines"."quantity" > 0 AND "supplier_invoice_lines"."unit_price" >= 0
          AND "supplier_invoice_lines"."amount" >= 0 AND "supplier_invoice_lines"."description" IS NULL)
        OR ("supplier_invoice_lines"."line_kind" <> 'ITEM' AND "supplier_invoice_lines"."receipt_line_id" IS NULL AND "supplier_invoice_lines"."quantity" IS NULL AND "supplier_invoice_lines"."unit_price" IS NULL
          AND char_length("supplier_invoice_lines"."description") BETWEEN 1 AND 200
          AND (("supplier_invoice_lines"."line_kind" = 'CREDIT' AND "supplier_invoice_lines"."amount" < 0) OR ("supplier_invoice_lines"."line_kind" <> 'CREDIT' AND "supplier_invoice_lines"."amount" >= 0)))),
	CONSTRAINT "supplier_invoice_lines_no_card_digits" CHECK (coalesce("supplier_invoice_lines"."description", '') !~ '[0-9]{13,}')
);
--> statement-breakpoint
CREATE TABLE "supplier_invoice_variances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"invoice_line_id" uuid NOT NULL,
	"received_quantity" numeric(14, 4) NOT NULL,
	"invoiced_quantity" numeric(14, 4) NOT NULL,
	"receipt_unit_cost" numeric(14, 4) NOT NULL,
	"ordered_unit_price" numeric(14, 4) NOT NULL,
	"invoiced_unit_price" numeric(14, 4) NOT NULL,
	"quantity_variance" numeric(14, 4) NOT NULL,
	"price_variance" numeric(14, 4) NOT NULL,
	"amount_variance" numeric(12, 2) NOT NULL,
	"price_percent" numeric(9, 2),
	"price_within_tolerance" boolean NOT NULL,
	"within_tolerance" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_invoice_variances_line_unique" UNIQUE("invoice_line_id")
);
--> statement-breakpoint
CREATE TABLE "supplier_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"sequence_number" integer NOT NULL,
	"invoice_number" text NOT NULL,
	"supplier_invoice_number" text NOT NULL,
	"invoice_date" date NOT NULL,
	"due_date" date,
	"stated_total" numeric(12, 2) NOT NULL,
	"notes" text,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"dispute_reason" text,
	"disputed_at" timestamp with time zone,
	"disputed_by_user_id" uuid,
	"approved_at" timestamp with time zone,
	"approved_by_user_id" uuid,
	"approval_reason" text,
	"voided_at" timestamp with time zone,
	"voided_by_user_id" uuid,
	"void_reason" text,
	"file_storage_key" text,
	"file_name" text,
	"file_content_type" text,
	"file_size_bytes" integer,
	"created_by_user_id" uuid NOT NULL,
	"updated_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "supplier_invoices_location_sequence_unique" UNIQUE("location_id","sequence_number"),
	CONSTRAINT "supplier_invoices_location_number_unique" UNIQUE("location_id","invoice_number"),
	CONSTRAINT "supplier_invoices_file_key_unique" UNIQUE("file_storage_key"),
	CONSTRAINT "supplier_invoices_sequence_positive" CHECK ("supplier_invoices"."sequence_number" > 0),
	CONSTRAINT "supplier_invoices_number_format" CHECK ("supplier_invoices"."invoice_number" ~ '^INV-[0-9]{6,}$'),
	CONSTRAINT "supplier_invoices_supplier_number_valid" CHECK ("supplier_invoices"."supplier_invoice_number" ~ '^[A-Za-z0-9/-]{1,40}$'),
	CONSTRAINT "supplier_invoices_status_valid" CHECK ("supplier_invoices"."status" IN ('DRAFT', 'DISPUTED', 'APPROVED', 'VOIDED')),
	CONSTRAINT "supplier_invoices_due_after_invoice" CHECK ("supplier_invoices"."due_date" IS NULL OR "supplier_invoices"."due_date" >= "supplier_invoices"."invoice_date"),
	CONSTRAINT "supplier_invoices_notes_length" CHECK ("supplier_invoices"."notes" IS NULL OR char_length("supplier_invoices"."notes") BETWEEN 1 AND 2000),
	CONSTRAINT "supplier_invoices_no_card_digits" CHECK (coalesce("supplier_invoices"."notes", '') !~ '[0-9]{13,}' AND coalesce("supplier_invoices"."dispute_reason", '') !~ '[0-9]{13,}'
        AND coalesce("supplier_invoices"."approval_reason", '') !~ '[0-9]{13,}' AND coalesce("supplier_invoices"."void_reason", '') !~ '[0-9]{13,}'),
	CONSTRAINT "supplier_invoices_dispute_recorded" CHECK (("supplier_invoices"."disputed_at" IS NULL AND "supplier_invoices"."disputed_by_user_id" IS NULL AND "supplier_invoices"."dispute_reason" IS NULL)
        OR ("supplier_invoices"."disputed_at" IS NOT NULL AND "supplier_invoices"."disputed_by_user_id" IS NOT NULL AND char_length("supplier_invoices"."dispute_reason") BETWEEN 1 AND 500)),
	CONSTRAINT "supplier_invoices_approval_recorded" CHECK (("supplier_invoices"."approved_at" IS NULL) = ("supplier_invoices"."approved_by_user_id" IS NULL)
        AND ("supplier_invoices"."status" <> 'APPROVED' OR "supplier_invoices"."approved_at" IS NOT NULL)
        AND ("supplier_invoices"."approval_reason" IS NULL OR char_length("supplier_invoices"."approval_reason") BETWEEN 1 AND 500)),
	CONSTRAINT "supplier_invoices_void_recorded" CHECK (("supplier_invoices"."status" = 'VOIDED') = ("supplier_invoices"."voided_at" IS NOT NULL)
        AND ("supplier_invoices"."voided_at" IS NULL OR ("supplier_invoices"."voided_by_user_id" IS NOT NULL AND char_length("supplier_invoices"."void_reason") BETWEEN 1 AND 500))),
	CONSTRAINT "supplier_invoices_file_recorded" CHECK (("supplier_invoices"."file_storage_key" IS NULL AND "supplier_invoices"."file_name" IS NULL AND "supplier_invoices"."file_content_type" IS NULL AND "supplier_invoices"."file_size_bytes" IS NULL)
        OR ("supplier_invoices"."file_storage_key" IS NOT NULL AND char_length("supplier_invoices"."file_name") BETWEEN 1 AND 200
          AND "supplier_invoices"."file_content_type" IN ('application/pdf', 'image/png', 'image/jpeg') AND "supplier_invoices"."file_size_bytes" > 0))
);
--> statement-breakpoint
ALTER TABLE "free_text_redactions" DROP CONSTRAINT "free_text_redactions_table_valid";--> statement-breakpoint
ALTER TABLE "location_settings" ADD COLUMN "invoice_price_tolerance_percent" numeric(5, 2) DEFAULT '2.00' NOT NULL;--> statement-breakpoint
ALTER TABLE "location_settings" ADD COLUMN "invoice_price_tolerance_amount" numeric(14, 4) DEFAULT '0.5000' NOT NULL;--> statement-breakpoint
ALTER TABLE "supplier_invoice_lines" ADD CONSTRAINT "supplier_invoice_lines_invoice_id_supplier_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."supplier_invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoice_lines" ADD CONSTRAINT "supplier_invoice_lines_receipt_line_fk" FOREIGN KEY ("receipt_line_id") REFERENCES "public"."purchase_order_receipt_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoice_variances" ADD CONSTRAINT "supplier_invoice_variances_invoice_id_supplier_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."supplier_invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoice_variances" ADD CONSTRAINT "supplier_invoice_variances_line_fk" FOREIGN KEY ("invoice_line_id") REFERENCES "public"."supplier_invoice_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_disputed_by_user_id_users_id_fk" FOREIGN KEY ("disputed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_voided_by_user_id_users_id_fk" FOREIGN KEY ("voided_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_location_org_fk" FOREIGN KEY ("location_id","organization_id") REFERENCES "public"."locations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_invoice_lines_receipt_line_unique" ON "supplier_invoice_lines" USING btree ("receipt_line_id") WHERE "supplier_invoice_lines"."holds_receipt_line" AND "supplier_invoice_lines"."receipt_line_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "supplier_invoice_lines_invoice_idx" ON "supplier_invoice_lines" USING btree ("invoice_id","sort_order");--> statement-breakpoint
CREATE INDEX "supplier_invoice_variances_invoice_idx" ON "supplier_invoice_variances" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_invoices_supplier_document_unique" ON "supplier_invoices" USING btree ("location_id","supplier_id",upper("supplier_invoice_number")) WHERE "supplier_invoices"."status" <> 'VOIDED';--> statement-breakpoint
CREATE INDEX "supplier_invoices_location_date_idx" ON "supplier_invoices" USING btree ("location_id","invoice_date");--> statement-breakpoint
CREATE INDEX "supplier_invoices_supplier_idx" ON "supplier_invoices" USING btree ("supplier_id");--> statement-breakpoint
ALTER TABLE "location_settings" ADD CONSTRAINT "location_settings_invoice_tolerance_valid" CHECK ("location_settings"."invoice_price_tolerance_percent" BETWEEN 0 AND 100 AND "location_settings"."invoice_price_tolerance_amount" >= 0);--> statement-breakpoint
ALTER TABLE "free_text_redactions" ADD CONSTRAINT "free_text_redactions_table_valid" CHECK ("free_text_redactions"."table_name" IN ('guest_parties', 'reservations', 'waitlist_entries', 'table_sessions', 'orders', 'order_items', 'kitchen_ticket_items', 'shifts', 'shift_assignments', 'gift_card_purchasers', 'checklist_run_items', 'temperature_readings', 'event_bookings', 'supplier_invoices'));