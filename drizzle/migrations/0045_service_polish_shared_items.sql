CREATE TABLE "order_item_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"split_group_id" uuid NOT NULL,
	"share_number" smallint NOT NULL,
	"share_count" smallint NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"tax_category_id" uuid,
	"tax_category_code_snapshot" text,
	"tax_rate_snapshot" numeric(7, 4),
	"tax_included_snapshot" boolean DEFAULT false NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by_user_id" uuid,
	"void_reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "order_item_shares_item_number_unique" UNIQUE("order_item_id","share_number"),
	CONSTRAINT "order_item_shares_status_valid" CHECK ("order_item_shares"."status" IN ('ACTIVE', 'VOIDED')),
	CONSTRAINT "order_item_shares_numbers_valid" CHECK ("order_item_shares"."share_count" BETWEEN 2 AND 10 AND "order_item_shares"."share_number" BETWEEN 1 AND "order_item_shares"."share_count"),
	CONSTRAINT "order_item_shares_amount_non_negative" CHECK ("order_item_shares"."amount" >= 0),
	CONSTRAINT "order_item_shares_void_fields" CHECK (("order_item_shares"."status" = 'VOIDED') = ("order_item_shares"."voided_at" IS NOT NULL)
        AND ("order_item_shares"."voided_at" IS NULL) = ("order_item_shares"."voided_by_user_id" IS NULL)
        AND ("order_item_shares"."voided_at" IS NULL OR length(trim(coalesce("order_item_shares"."void_reason", ''))) > 0)),
	CONSTRAINT "order_item_shares_tax_fields" CHECK (("order_item_shares"."tax_category_id" IS NULL) = ("order_item_shares"."tax_rate_snapshot" IS NULL)
        AND ("order_item_shares"."tax_category_id" IS NULL) = ("order_item_shares"."tax_category_code_snapshot" IS NULL)
        AND ("order_item_shares"."tax_rate_snapshot" IS NOT NULL OR NOT "order_item_shares"."tax_included_snapshot"))
);
--> statement-breakpoint
ALTER TABLE "order_items" DROP CONSTRAINT "order_items_status_valid";--> statement-breakpoint
ALTER TABLE "order_item_shares" ADD CONSTRAINT "order_item_shares_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_shares" ADD CONSTRAINT "order_item_shares_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_shares" ADD CONSTRAINT "order_item_shares_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_shares" ADD CONSTRAINT "order_item_shares_tax_category_id_tax_categories_id_fk" FOREIGN KEY ("tax_category_id") REFERENCES "public"."tax_categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_shares" ADD CONSTRAINT "order_item_shares_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_shares" ADD CONSTRAINT "order_item_shares_voided_by_user_id_users_id_fk" FOREIGN KEY ("voided_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_item_shares_order_idx" ON "order_item_shares" USING btree ("order_id","status");--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_status_valid" CHECK ("order_items"."status" IN ('DRAFT', 'SUBMITTED', 'VOIDED', 'SPLIT'));