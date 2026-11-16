CREATE TABLE "purchasing_forecast_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purchasing_forecast_id" uuid NOT NULL,
	"inventory_item_id" uuid NOT NULL,
	"basis" text NOT NULL,
	"forecast_usage" numeric(14, 4),
	"reorder_floor" numeric(14, 4),
	"quantity_on_hand" numeric(14, 4) NOT NULL,
	"on_order" numeric(14, 4) NOT NULL,
	"need" numeric(14, 4) NOT NULL,
	"supplier_item_id" uuid,
	"ordered_quantity" numeric(14, 4),
	CONSTRAINT "purchasing_forecast_lines_forecast_item_unique" UNIQUE("purchasing_forecast_id","inventory_item_id"),
	CONSTRAINT "purchasing_forecast_lines_basis_valid" CHECK ("purchasing_forecast_lines"."basis" IN ('FORECAST', 'PAR')),
	CONSTRAINT "purchasing_forecast_lines_usage_matches_basis" CHECK (("purchasing_forecast_lines"."basis" = 'FORECAST') = ("purchasing_forecast_lines"."forecast_usage" IS NOT NULL)),
	CONSTRAINT "purchasing_forecast_lines_need_positive" CHECK ("purchasing_forecast_lines"."need" > 0)
);
--> statement-breakpoint
CREATE TABLE "purchasing_forecasts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"from_date" date NOT NULL,
	"through_date" date NOT NULL,
	"method" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchasing_forecasts_dates_valid" CHECK ("purchasing_forecasts"."through_date" >= "purchasing_forecasts"."from_date")
);
--> statement-breakpoint
CREATE TABLE "purchasing_forecast_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purchasing_forecast_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"menu_item_id" uuid NOT NULL,
	"status" text NOT NULL,
	"portions" numeric(14, 2),
	"new_item" boolean NOT NULL,
	"recipe_version_id" uuid,
	CONSTRAINT "purchasing_forecast_items_forecast_date_item_unique" UNIQUE("purchasing_forecast_id","business_date","menu_item_id"),
	CONSTRAINT "purchasing_forecast_items_status_valid" CHECK ("purchasing_forecast_items"."status" IN ('OK', 'NOT_ENOUGH_HISTORY')),
	CONSTRAINT "purchasing_forecast_items_portions_match_status" CHECK (("purchasing_forecast_items"."status" = 'OK') = ("purchasing_forecast_items"."portions" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "purchasing_forecast_id" uuid;--> statement-breakpoint
ALTER TABLE "purchasing_forecast_lines" ADD CONSTRAINT "purchasing_forecast_lines_forecast_fk" FOREIGN KEY ("purchasing_forecast_id") REFERENCES "public"."purchasing_forecasts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchasing_forecast_lines" ADD CONSTRAINT "purchasing_forecast_lines_item_fk" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."inventory_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchasing_forecast_lines" ADD CONSTRAINT "purchasing_forecast_lines_supplier_item_fk" FOREIGN KEY ("supplier_item_id") REFERENCES "public"."supplier_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchasing_forecasts" ADD CONSTRAINT "purchasing_forecasts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchasing_forecasts" ADD CONSTRAINT "purchasing_forecasts_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchasing_forecasts" ADD CONSTRAINT "purchasing_forecasts_location_org_fk" FOREIGN KEY ("location_id","organization_id") REFERENCES "public"."locations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchasing_forecast_items" ADD CONSTRAINT "purchasing_forecast_items_recipe_version_fk" FOREIGN KEY ("recipe_version_id") REFERENCES "public"."recipe_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchasing_forecast_items" ADD CONSTRAINT "purchasing_forecast_items_forecast_fk" FOREIGN KEY ("purchasing_forecast_id") REFERENCES "public"."purchasing_forecasts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchasing_forecast_items" ADD CONSTRAINT "purchasing_forecast_items_menu_item_fk" FOREIGN KEY ("menu_item_id") REFERENCES "public"."menu_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "purchasing_forecasts_location_created_idx" ON "purchasing_forecasts" USING btree ("location_id","created_at");--> statement-breakpoint
CREATE INDEX "purchasing_forecast_items_date_idx" ON "purchasing_forecast_items" USING btree ("business_date");--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_purchasing_forecast_fk" FOREIGN KEY ("purchasing_forecast_id") REFERENCES "public"."purchasing_forecasts"("id") ON DELETE restrict ON UPDATE no action;