CREATE TABLE "modifier_outages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"modifier_id" uuid NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"reason" text NOT NULL,
	"marked_out_at" timestamp with time zone NOT NULL,
	"marked_out_by_user_id" uuid NOT NULL,
	"starts_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ends_at" timestamp with time zone,
	"restored_at" timestamp with time zone,
	"restored_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "modifier_outages_status_valid" CHECK ("modifier_outages"."status" IN ('ACTIVE', 'RESTORED')),
	CONSTRAINT "modifier_outages_reason_not_blank" CHECK (length(trim("modifier_outages"."reason")) > 0),
	CONSTRAINT "modifier_outages_restore_consistent" CHECK (("modifier_outages"."status" = 'ACTIVE' AND "modifier_outages"."restored_at" IS NULL AND "modifier_outages"."restored_by_user_id" IS NULL) OR ("modifier_outages"."status" = 'RESTORED' AND "modifier_outages"."restored_at" IS NOT NULL AND "modifier_outages"."restored_by_user_id" IS NOT NULL AND "modifier_outages"."restored_at" >= "modifier_outages"."marked_out_at")),
	CONSTRAINT "modifier_outages_window_valid" CHECK ("modifier_outages"."starts_at" >= "modifier_outages"."marked_out_at" AND ("modifier_outages"."ends_at" IS NULL OR "modifier_outages"."ends_at" > "modifier_outages"."starts_at"))
);
--> statement-breakpoint
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_category_valid";--> statement-breakpoint
DROP INDEX "menu_item_outages_one_active";--> statement-breakpoint
ALTER TABLE "menu_item_outages" ADD COLUMN "starts_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "menu_item_outages" ADD COLUMN "ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "menu_category_id" uuid;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "menu_category_name_snapshot" text;--> statement-breakpoint
ALTER TABLE "location_settings" ADD COLUMN "running_low_portions" smallint DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "modifier_outages" ADD CONSTRAINT "modifier_outages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modifier_outages" ADD CONSTRAINT "modifier_outages_marked_out_by_user_id_users_id_fk" FOREIGN KEY ("marked_out_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modifier_outages" ADD CONSTRAINT "modifier_outages_restored_by_user_id_users_id_fk" FOREIGN KEY ("restored_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modifier_outages" ADD CONSTRAINT "modifier_outages_location_org_fk" FOREIGN KEY ("location_id","organization_id") REFERENCES "public"."locations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modifier_outages" ADD CONSTRAINT "modifier_outages_modifier_org_fk" FOREIGN KEY ("modifier_id","organization_id") REFERENCES "public"."modifiers"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "modifier_outages_location_marked_idx" ON "modifier_outages" USING btree ("location_id","marked_out_at");--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_menu_category_id_menu_categories_id_fk" FOREIGN KEY ("menu_category_id") REFERENCES "public"."menu_categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_category_valid" CHECK ("audit_events"."category" IN ('ACCESS', 'SECURITY', 'HR', 'SCHEDULING', 'ORDERS', 'MENU', 'INVENTORY', 'SETTLEMENTS', 'REPORTING', 'SYSTEM', 'ORGANIZATION'));--> statement-breakpoint
ALTER TABLE "menu_item_outages" ADD CONSTRAINT "menu_item_outages_window_valid" CHECK ("menu_item_outages"."starts_at" >= "menu_item_outages"."marked_out_at" AND ("menu_item_outages"."ends_at" IS NULL OR "menu_item_outages"."ends_at" > "menu_item_outages"."starts_at"));--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_category_snapshot_fields" CHECK (("order_items"."menu_category_id" IS NULL) = ("order_items"."menu_category_name_snapshot" IS NULL)
        AND ("order_items"."status" <> 'DRAFT' OR "order_items"."menu_category_id" IS NULL));--> statement-breakpoint
ALTER TABLE "location_settings" ADD CONSTRAINT "location_settings_running_low_range" CHECK ("location_settings"."running_low_portions" BETWEEN 1 AND 99);