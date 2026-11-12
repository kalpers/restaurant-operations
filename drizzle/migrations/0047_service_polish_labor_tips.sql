CREATE TABLE "tip_declarations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"note" text,
	"declared_by_user_id" uuid NOT NULL,
	"declared_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "tip_declarations_employee_date_unique" UNIQUE("employee_id","location_id","business_date"),
	CONSTRAINT "tip_declarations_amount_non_negative" CHECK ("tip_declarations"."amount" >= 0),
	CONSTRAINT "tip_declarations_note_length" CHECK ("tip_declarations"."note" IS NULL OR length("tip_declarations"."note") <= 300)
);
--> statement-breakpoint
ALTER TABLE "order_refunds" DROP CONSTRAINT "order_refunds_amounts_valid";--> statement-breakpoint
ALTER TABLE "scheduling_rules" ADD COLUMN "daily_overtime_threshold" numeric(6, 2);--> statement-breakpoint
ALTER TABLE "order_refunds" ADD COLUMN "tip_amount" numeric(12, 2) DEFAULT '0.00' NOT NULL;--> statement-breakpoint
ALTER TABLE "tip_declarations" ADD CONSTRAINT "tip_declarations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_declarations" ADD CONSTRAINT "tip_declarations_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_declarations" ADD CONSTRAINT "tip_declarations_declared_by_user_id_users_id_fk" FOREIGN KEY ("declared_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_declarations" ADD CONSTRAINT "tip_declarations_location_org_fk" FOREIGN KEY ("location_id","organization_id") REFERENCES "public"."locations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tip_declarations_location_date_idx" ON "tip_declarations" USING btree ("location_id","business_date");--> statement-breakpoint
ALTER TABLE "scheduling_rules" ADD CONSTRAINT "scheduling_rules_daily_overtime_valid" CHECK ("scheduling_rules"."daily_overtime_threshold" IS NULL OR ("scheduling_rules"."daily_overtime_threshold" > 0 AND "scheduling_rules"."daily_overtime_threshold" <= 24));--> statement-breakpoint
ALTER TABLE "order_refunds" ADD CONSTRAINT "order_refunds_amounts_valid" CHECK ("order_refunds"."amount" >= 0 AND "order_refunds"."tax_amount" >= 0 AND "order_refunds"."tax_amount" <= "order_refunds"."amount"
        AND "order_refunds"."tip_amount" >= 0 AND "order_refunds"."amount" + "order_refunds"."tip_amount" > 0
        AND ("order_refunds"."tip_amount" = 0 OR "order_refunds"."tender_type" IN ('CASH', 'EXTERNAL_CARD')));