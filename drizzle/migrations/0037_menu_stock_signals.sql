CREATE TABLE "inventory_stock_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"inventory_item_id" uuid NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"quantity_when_opened" numeric(14, 4) NOT NULL,
	"reorder_level_when_opened" numeric(14, 4) NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"opened_by_transaction_id" uuid NOT NULL,
	"resolved_at" timestamp with time zone,
	"quantity_when_resolved" numeric(14, 4),
	"resolved_by_transaction_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_stock_alerts_status_valid" CHECK ("inventory_stock_alerts"."status" IN ('OPEN', 'RESOLVED')),
	CONSTRAINT "inventory_stock_alerts_resolve_consistent" CHECK (("inventory_stock_alerts"."status" = 'OPEN' AND "inventory_stock_alerts"."resolved_at" IS NULL AND "inventory_stock_alerts"."quantity_when_resolved" IS NULL AND "inventory_stock_alerts"."resolved_by_transaction_id" IS NULL) OR ("inventory_stock_alerts"."status" = 'RESOLVED' AND "inventory_stock_alerts"."resolved_at" IS NOT NULL AND "inventory_stock_alerts"."quantity_when_resolved" IS NOT NULL AND "inventory_stock_alerts"."resolved_by_transaction_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "menu_item_outages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"menu_item_id" uuid NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"reason" text NOT NULL,
	"marked_out_at" timestamp with time zone NOT NULL,
	"marked_out_by_user_id" uuid NOT NULL,
	"restored_at" timestamp with time zone,
	"restored_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "menu_item_outages_status_valid" CHECK ("menu_item_outages"."status" IN ('ACTIVE', 'RESTORED')),
	CONSTRAINT "menu_item_outages_reason_not_blank" CHECK (length(trim("menu_item_outages"."reason")) > 0),
	CONSTRAINT "menu_item_outages_restore_consistent" CHECK (("menu_item_outages"."status" = 'ACTIVE' AND "menu_item_outages"."restored_at" IS NULL AND "menu_item_outages"."restored_by_user_id" IS NULL) OR ("menu_item_outages"."status" = 'RESTORED' AND "menu_item_outages"."restored_at" IS NOT NULL AND "menu_item_outages"."restored_by_user_id" IS NOT NULL AND "menu_item_outages"."restored_at" >= "menu_item_outages"."marked_out_at"))
);
--> statement-breakpoint
CREATE TABLE "menu_item_stock_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"menu_item_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"reason" text NOT NULL,
	"set_at" timestamp with time zone NOT NULL,
	"set_by_user_id" uuid NOT NULL,
	"cleared_at" timestamp with time zone,
	"cleared_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "menu_item_stock_overrides_reason_not_blank" CHECK (length(trim("menu_item_stock_overrides"."reason")) > 0),
	CONSTRAINT "menu_item_stock_overrides_clear_consistent" CHECK (("menu_item_stock_overrides"."cleared_at" IS NULL) = ("menu_item_stock_overrides"."cleared_by_user_id" IS NULL) AND ("menu_item_stock_overrides"."cleared_at" IS NULL OR "menu_item_stock_overrides"."cleared_at" >= "menu_item_stock_overrides"."set_at"))
);
--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_type_valid";--> statement-breakpoint
ALTER TABLE "inventory_item_locations" ADD COLUMN "preferred_supplier_item_id" uuid;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "inventory_stock_alert_id" uuid;--> statement-breakpoint
ALTER TABLE "location_settings" ADD COLUMN "auto_86_from_stock" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_stock_alerts" ADD CONSTRAINT "inventory_stock_alerts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_stock_alerts" ADD CONSTRAINT "inventory_stock_alerts_item_org_fk" FOREIGN KEY ("inventory_item_id","organization_id") REFERENCES "public"."inventory_items"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_stock_alerts" ADD CONSTRAINT "inventory_stock_alerts_location_org_fk" FOREIGN KEY ("location_id","organization_id") REFERENCES "public"."locations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_stock_alerts" ADD CONSTRAINT "inventory_stock_alerts_opened_tx_fk" FOREIGN KEY ("opened_by_transaction_id") REFERENCES "public"."inventory_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_stock_alerts" ADD CONSTRAINT "inventory_stock_alerts_resolved_tx_fk" FOREIGN KEY ("resolved_by_transaction_id") REFERENCES "public"."inventory_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_outages" ADD CONSTRAINT "menu_item_outages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_outages" ADD CONSTRAINT "menu_item_outages_marked_out_by_user_id_users_id_fk" FOREIGN KEY ("marked_out_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_outages" ADD CONSTRAINT "menu_item_outages_restored_by_user_id_users_id_fk" FOREIGN KEY ("restored_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_outages" ADD CONSTRAINT "menu_item_outages_location_org_fk" FOREIGN KEY ("location_id","organization_id") REFERENCES "public"."locations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_outages" ADD CONSTRAINT "menu_item_outages_item_org_fk" FOREIGN KEY ("menu_item_id","organization_id") REFERENCES "public"."menu_items"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_stock_overrides" ADD CONSTRAINT "menu_item_stock_overrides_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_stock_overrides" ADD CONSTRAINT "menu_item_stock_overrides_set_by_user_id_users_id_fk" FOREIGN KEY ("set_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_stock_overrides" ADD CONSTRAINT "menu_item_stock_overrides_cleared_by_user_id_users_id_fk" FOREIGN KEY ("cleared_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_stock_overrides" ADD CONSTRAINT "menu_item_stock_overrides_location_org_fk" FOREIGN KEY ("location_id","organization_id") REFERENCES "public"."locations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_stock_overrides" ADD CONSTRAINT "menu_item_stock_overrides_item_org_fk" FOREIGN KEY ("menu_item_id","organization_id") REFERENCES "public"."menu_items"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_stock_alerts_one_open" ON "inventory_stock_alerts" USING btree ("location_id","inventory_item_id") WHERE "inventory_stock_alerts"."status" = 'OPEN';--> statement-breakpoint
CREATE INDEX "inventory_stock_alerts_location_opened_idx" ON "inventory_stock_alerts" USING btree ("location_id","opened_at");--> statement-breakpoint
CREATE UNIQUE INDEX "menu_item_outages_one_active" ON "menu_item_outages" USING btree ("location_id","menu_item_id") WHERE "menu_item_outages"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "menu_item_outages_location_marked_idx" ON "menu_item_outages" USING btree ("location_id","marked_out_at");--> statement-breakpoint
CREATE UNIQUE INDEX "menu_item_stock_overrides_one_open" ON "menu_item_stock_overrides" USING btree ("location_id","menu_item_id","business_date") WHERE "menu_item_stock_overrides"."cleared_at" IS NULL;--> statement-breakpoint
CREATE INDEX "menu_item_stock_overrides_location_date_idx" ON "menu_item_stock_overrides" USING btree ("location_id","business_date");--> statement-breakpoint
ALTER TABLE "supplier_items" ADD CONSTRAINT "supplier_items_id_item_org_unique" UNIQUE("id","inventory_item_id","organization_id");--> statement-breakpoint
ALTER TABLE "inventory_item_locations" ADD CONSTRAINT "inventory_item_locations_preferred_supplier_item_fk" FOREIGN KEY ("preferred_supplier_item_id","inventory_item_id","organization_id") REFERENCES "public"."supplier_items"("id","inventory_item_id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_stock_alert_fk" FOREIGN KEY ("inventory_stock_alert_id") REFERENCES "public"."inventory_stock_alerts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_alert_recipient_unique" UNIQUE("inventory_stock_alert_id","recipient_user_id");--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_type_valid" CHECK ("notifications"."notification_type" IN ('FOOD_READY', 'BAR_ORDER_READY', 'INVENTORY_LOW'));