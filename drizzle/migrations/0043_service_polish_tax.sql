ALTER TABLE "order_tax_lines" DROP CONSTRAINT "order_tax_lines_order_category_rate_unique";--> statement-breakpoint
ALTER TABLE "order_items" DROP CONSTRAINT "order_items_tax_snapshot_fields";--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT "orders_totals_valid";--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "tax_included_snapshot" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "order_tax_lines" ADD COLUMN "tax_included" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "included_tax_total" numeric(12, 2) DEFAULT '0.00' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "tax_exempt" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "tax_exempt_reason" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "tax_exempt_reference" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "tax_exempt_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "tax_exempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tax_rates" ADD COLUMN "price_includes_tax" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_tax_exempt_by_user_id_users_id_fk" FOREIGN KEY ("tax_exempt_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_tax_lines" ADD CONSTRAINT "order_tax_lines_order_category_rate_unique" UNIQUE("order_id","tax_category_id","tax_rate_snapshot","tax_included");--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_tax_snapshot_fields" CHECK (("order_items"."tax_category_id" IS NULL) = ("order_items"."tax_category_code_snapshot" IS NULL)
        AND ("order_items"."tax_category_id" IS NULL) = ("order_items"."tax_rate_snapshot" IS NULL)
        AND ("order_items"."status" <> 'DRAFT' OR "order_items"."tax_category_id" IS NULL)
        AND ("order_items"."tax_rate_snapshot" IS NULL OR ("order_items"."tax_rate_snapshot" >= 0 AND "order_items"."tax_rate_snapshot" <= 100))
        AND ("order_items"."tax_rate_snapshot" IS NOT NULL OR NOT "order_items"."tax_included_snapshot"));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_included_tax_valid" CHECK ("orders"."included_tax_total" >= 0 AND ("orders"."tax_exempt" OR "orders"."included_tax_total" <= "orders"."tax_total"));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_tax_exempt_fields" CHECK (("orders"."tax_exempt" = ("orders"."tax_exempt_reason" IS NOT NULL))
        AND ("orders"."tax_exempt" = ("orders"."tax_exempt_by_user_id" IS NOT NULL))
        AND ("orders"."tax_exempt" = ("orders"."tax_exempt_at" IS NOT NULL))
        AND ("orders"."tax_exempt_reference" IS NULL OR "orders"."tax_exempt")
        AND (NOT "orders"."tax_exempt" OR "orders"."tax_total" = 0)
        AND ("orders"."tax_exempt_reason" IS NULL OR length(trim("orders"."tax_exempt_reason")) > 0)
        AND ("orders"."tax_exempt_reference" IS NULL OR "orders"."tax_exempt_reference" !~ '[0-9]{13}'));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_totals_valid" CHECK ("orders"."item_subtotal" >= 0 AND "orders"."discount_total" >= 0
        AND "orders"."discount_total" <= "orders"."item_subtotal"
        AND "orders"."subtotal" = "orders"."item_subtotal" - "orders"."discount_total" - "orders"."included_tax_total");