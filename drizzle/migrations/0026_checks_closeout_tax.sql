CREATE TABLE "order_tax_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"tax_category_id" uuid NOT NULL,
	"tax_category_code_snapshot" text NOT NULL,
	"tax_rate_snapshot" numeric(7, 4) NOT NULL,
	"taxable_amount" numeric(12, 2) NOT NULL,
	"tax_amount" numeric(12, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_tax_lines_order_category_rate_unique" UNIQUE("order_id","tax_category_id","tax_rate_snapshot"),
	CONSTRAINT "order_tax_lines_amounts_valid" CHECK ("order_tax_lines"."taxable_amount" >= 0 AND "order_tax_lines"."tax_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "tax_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "tax_categories_organization_id_code_unique" UNIQUE("organization_id","code"),
	CONSTRAINT "tax_categories_id_organization_id_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "tax_categories_code_not_blank" CHECK (length(trim("tax_categories"."code")) > 0),
	CONSTRAINT "tax_categories_name_not_blank" CHECK (length(trim("tax_categories"."name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "tax_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"tax_category_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"rate_percent" numeric(7, 4) NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_rates_rate_range" CHECK ("tax_rates"."rate_percent" >= 0 AND "tax_rates"."rate_percent" <= 100),
	CONSTRAINT "tax_rates_interval_valid" CHECK ("tax_rates"."effective_to" IS NULL OR "tax_rates"."effective_to" > "tax_rates"."effective_from")
);
--> statement-breakpoint
ALTER TABLE "menu_items" ADD COLUMN "tax_category_id" uuid;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "course_number" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "tax_category_id" uuid;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "tax_category_code_snapshot" text;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "tax_rate_snapshot" numeric(7, 4);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "tax_total" numeric(12, 2) DEFAULT '0.00' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "total_due" numeric(12, 2) GENERATED ALWAYS AS (subtotal + tax_total) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "location_settings" ADD COLUMN "tax_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "order_settlements" ADD COLUMN "tax_total_snapshot" numeric(12, 2) DEFAULT '0.00' NOT NULL;--> statement-breakpoint
ALTER TABLE "order_settlements" ADD COLUMN "subtotal_snapshot" numeric(12, 2) GENERATED ALWAYS AS (order_amount_snapshot - tax_total_snapshot) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "order_tax_lines" ADD CONSTRAINT "order_tax_lines_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_tax_lines" ADD CONSTRAINT "order_tax_lines_tax_category_id_tax_categories_id_fk" FOREIGN KEY ("tax_category_id") REFERENCES "public"."tax_categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_categories" ADD CONSTRAINT "tax_categories_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_rates" ADD CONSTRAINT "tax_rates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_rates" ADD CONSTRAINT "tax_rates_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_rates" ADD CONSTRAINT "tax_rates_category_org_fk" FOREIGN KEY ("tax_category_id","organization_id") REFERENCES "public"."tax_categories"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_rates" ADD CONSTRAINT "tax_rates_location_org_fk" FOREIGN KEY ("location_id","organization_id") REFERENCES "public"."locations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tax_rates_category_location_from_idx" ON "tax_rates" USING btree ("tax_category_id","location_id","effective_from");--> statement-breakpoint
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_tax_category_org_fk" FOREIGN KEY ("tax_category_id","organization_id") REFERENCES "public"."tax_categories"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_tax_category_id_tax_categories_id_fk" FOREIGN KEY ("tax_category_id") REFERENCES "public"."tax_categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_course_range" CHECK ("order_items"."course_number" BETWEEN 1 AND 5);--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_tax_snapshot_fields" CHECK (("order_items"."tax_category_id" IS NULL) = ("order_items"."tax_category_code_snapshot" IS NULL)
        AND ("order_items"."tax_category_id" IS NULL) = ("order_items"."tax_rate_snapshot" IS NULL)
        AND ("order_items"."status" <> 'DRAFT' OR "order_items"."tax_category_id" IS NULL)
        AND ("order_items"."tax_rate_snapshot" IS NULL OR ("order_items"."tax_rate_snapshot" >= 0 AND "order_items"."tax_rate_snapshot" <= 100)));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_tax_total_non_negative" CHECK ("orders"."tax_total" >= 0);--> statement-breakpoint
ALTER TABLE "order_settlements" ADD CONSTRAINT "order_settlements_tax_snapshot_valid" CHECK ("order_settlements"."tax_total_snapshot" >= 0 AND "order_settlements"."tax_total_snapshot" <= "order_settlements"."order_amount_snapshot");