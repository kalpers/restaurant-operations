CREATE TABLE "inventory_costing_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"inventory_item_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"from_method" text NOT NULL,
	"to_method" text NOT NULL,
	"quantity_on_hand" numeric(14, 4) NOT NULL,
	"value_before" numeric(14, 4),
	"value_after" numeric(14, 4),
	"average_cost_after" numeric(14, 4),
	"last_transaction_sequence" bigint,
	"reason_code" text NOT NULL,
	"changed_by_user_id" uuid NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_costing_changes_methods_valid" CHECK ("inventory_costing_changes"."from_method" IN ('WEIGHTED_AVERAGE', 'LOT') AND "inventory_costing_changes"."to_method" IN ('WEIGHTED_AVERAGE', 'LOT') AND "inventory_costing_changes"."from_method" <> "inventory_costing_changes"."to_method"),
	CONSTRAINT "inventory_costing_changes_reason_valid" CHECK ("inventory_costing_changes"."reason_code" IN ('SUPPLIER_PRICES_VARY', 'OWNER_OR_ACCOUNTANT_REQUEST', 'CORRECTION', 'OTHER'))
);
--> statement-breakpoint
ALTER TABLE "inventory_balances" ADD COLUMN "stock_value" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "inventory_items" ADD COLUMN "costing_method" text DEFAULT 'WEIGHTED_AVERAGE' NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_lot_movements" ADD COLUMN "unit_cost" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "inventory_lot_movements" ADD COLUMN "total_cost" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "inventory_lot_movements" ADD COLUMN "cost_difference" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "inventory_lots" ADD COLUMN "carrying_unit_cost" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "inventory_lots" ADD COLUMN "value_remaining" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "inventory_transactions" ADD COLUMN "stock_value_after" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "inventory_transfer_lines" ADD COLUMN "value_sent" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "inventory_costing_changes" ADD CONSTRAINT "inventory_costing_changes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_costing_changes" ADD CONSTRAINT "inventory_costing_changes_changed_by_user_id_users_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_costing_changes" ADD CONSTRAINT "inventory_costing_changes_item_org_fk" FOREIGN KEY ("inventory_item_id","organization_id") REFERENCES "public"."inventory_items"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_costing_changes" ADD CONSTRAINT "inventory_costing_changes_location_org_fk" FOREIGN KEY ("location_id","organization_id") REFERENCES "public"."locations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inventory_costing_changes_item_location_idx" ON "inventory_costing_changes" USING btree ("inventory_item_id","location_id","changed_at");--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_costing_method_valid" CHECK ("inventory_items"."costing_method" IN ('WEIGHTED_AVERAGE', 'LOT'));--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_lot_costing_needs_lots" CHECK ("inventory_items"."costing_method" = 'WEIGHTED_AVERAGE' OR "inventory_items"."lot_tracked");--> statement-breakpoint
ALTER TABLE "inventory_lot_movements" ADD CONSTRAINT "inventory_lot_movements_cost_non_negative" CHECK (("inventory_lot_movements"."unit_cost" IS NULL OR "inventory_lot_movements"."unit_cost" >= 0) AND ("inventory_lot_movements"."total_cost" IS NULL OR "inventory_lot_movements"."total_cost" >= 0));--> statement-breakpoint
ALTER TABLE "inventory_lots" ADD CONSTRAINT "inventory_lots_carrying_non_negative" CHECK (("inventory_lots"."carrying_unit_cost" IS NULL OR "inventory_lots"."carrying_unit_cost" >= 0) AND ("inventory_lots"."value_remaining" IS NULL OR "inventory_lots"."value_remaining" >= 0));--> statement-breakpoint
ALTER TABLE "inventory_transfer_lines" ADD CONSTRAINT "inventory_transfer_lines_value_non_negative" CHECK ("inventory_transfer_lines"."value_sent" IS NULL OR "inventory_transfer_lines"."value_sent" >= 0);