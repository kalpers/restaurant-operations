CREATE TABLE "inventory_lot_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"inventory_transaction_id" uuid NOT NULL,
	"lot_id" uuid,
	"base_quantity_delta" numeric(14, 4) NOT NULL,
	"settles_movement_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_lot_movements_delta_non_zero" CHECK ("inventory_lot_movements"."base_quantity_delta" <> 0),
	CONSTRAINT "inventory_lot_movements_settlement_shape" CHECK ("inventory_lot_movements"."settles_movement_id" IS NULL OR ("inventory_lot_movements"."lot_id" IS NULL AND "inventory_lot_movements"."base_quantity_delta" > 0))
);
--> statement-breakpoint
CREATE TABLE "inventory_lots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"inventory_item_id" uuid NOT NULL,
	"sequence_number" integer NOT NULL,
	"lot_number" text NOT NULL,
	"supplier_lot_code" text,
	"expires_on" date,
	"received_on" date NOT NULL,
	"origin" text NOT NULL,
	"source_lot_id" uuid,
	"unit_cost" numeric(14, 4),
	"quantity_received" numeric(14, 4) NOT NULL,
	"quantity_remaining" numeric(14, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "inventory_lots_location_number_unique" UNIQUE("location_id","lot_number"),
	CONSTRAINT "inventory_lots_location_sequence_unique" UNIQUE("location_id","sequence_number"),
	CONSTRAINT "inventory_lots_origin_valid" CHECK ("inventory_lots"."origin" IN ('RECEIPT', 'TRANSFER', 'OPENING', 'FOUND')),
	CONSTRAINT "inventory_lots_transfer_source" CHECK (("inventory_lots"."origin" = 'TRANSFER') = ("inventory_lots"."source_lot_id" IS NOT NULL)),
	CONSTRAINT "inventory_lots_quantities_valid" CHECK ("inventory_lots"."quantity_received" > 0 AND "inventory_lots"."quantity_remaining" >= 0),
	CONSTRAINT "inventory_lots_supplier_code_length" CHECK ("inventory_lots"."supplier_lot_code" IS NULL OR (length(trim("inventory_lots"."supplier_lot_code")) BETWEEN 1 AND 64)),
	CONSTRAINT "inventory_lots_cost_non_negative" CHECK ("inventory_lots"."unit_cost" IS NULL OR "inventory_lots"."unit_cost" >= 0)
);
--> statement-breakpoint
ALTER TABLE "inventory_items" ADD COLUMN "lot_tracked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_transfer_lines" ADD COLUMN "lot_id" uuid;--> statement-breakpoint
ALTER TABLE "location_settings" ADD COLUMN "lot_expiry_warning_days" smallint DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_lot_movements" ADD CONSTRAINT "inventory_lot_movements_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_lot_movements" ADD CONSTRAINT "inventory_lot_movements_transaction_fk" FOREIGN KEY ("inventory_transaction_id") REFERENCES "public"."inventory_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_lot_movements" ADD CONSTRAINT "inventory_lot_movements_lot_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."inventory_lots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_lot_movements" ADD CONSTRAINT "inventory_lot_movements_settles_fk" FOREIGN KEY ("settles_movement_id") REFERENCES "public"."inventory_lot_movements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_lots" ADD CONSTRAINT "inventory_lots_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_lots" ADD CONSTRAINT "inventory_lots_item_org_fk" FOREIGN KEY ("inventory_item_id","organization_id") REFERENCES "public"."inventory_items"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_lots" ADD CONSTRAINT "inventory_lots_location_org_fk" FOREIGN KEY ("location_id","organization_id") REFERENCES "public"."locations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_lots" ADD CONSTRAINT "inventory_lots_source_fk" FOREIGN KEY ("source_lot_id") REFERENCES "public"."inventory_lots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inventory_lot_movements_transaction_idx" ON "inventory_lot_movements" USING btree ("inventory_transaction_id");--> statement-breakpoint
CREATE INDEX "inventory_lot_movements_lot_idx" ON "inventory_lot_movements" USING btree ("lot_id");--> statement-breakpoint
CREATE INDEX "inventory_lot_movements_settles_idx" ON "inventory_lot_movements" USING btree ("settles_movement_id");--> statement-breakpoint
CREATE INDEX "inventory_lots_item_location_fefo_idx" ON "inventory_lots" USING btree ("inventory_item_id","location_id","expires_on","received_on","sequence_number") WHERE "inventory_lots"."quantity_remaining" > 0;--> statement-breakpoint
CREATE INDEX "inventory_lots_location_expires_idx" ON "inventory_lots" USING btree ("location_id","expires_on") WHERE "inventory_lots"."quantity_remaining" > 0;--> statement-breakpoint
ALTER TABLE "inventory_transfer_lines" ADD CONSTRAINT "inventory_transfer_lines_lot_id_inventory_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."inventory_lots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_settings" ADD CONSTRAINT "location_settings_lot_expiry_warning_range" CHECK ("location_settings"."lot_expiry_warning_days" BETWEEN 0 AND 30);