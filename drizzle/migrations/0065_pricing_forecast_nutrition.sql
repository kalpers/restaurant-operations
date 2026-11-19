CREATE TABLE "inventory_item_nutrition" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"inventory_item_id" uuid NOT NULL,
	"basis_quantity" numeric(14, 4) NOT NULL,
	"calories" numeric(14, 4),
	"fat_g" numeric(14, 4),
	"saturated_fat_g" numeric(14, 4),
	"carbohydrate_g" numeric(14, 4),
	"sugars_g" numeric(14, 4),
	"fibre_g" numeric(14, 4),
	"protein_g" numeric(14, 4),
	"sodium_mg" numeric(14, 4),
	"updated_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "inventory_item_nutrition_item_unique" UNIQUE("inventory_item_id"),
	CONSTRAINT "inventory_item_nutrition_basis_positive" CHECK ("inventory_item_nutrition"."basis_quantity" > 0),
	CONSTRAINT "inventory_item_nutrition_figures_non_negative" CHECK (("inventory_item_nutrition"."calories" IS NULL OR "inventory_item_nutrition"."calories" >= 0) AND ("inventory_item_nutrition"."fat_g" IS NULL OR "inventory_item_nutrition"."fat_g" >= 0) AND ("inventory_item_nutrition"."saturated_fat_g" IS NULL OR "inventory_item_nutrition"."saturated_fat_g" >= 0) AND ("inventory_item_nutrition"."carbohydrate_g" IS NULL OR "inventory_item_nutrition"."carbohydrate_g" >= 0) AND ("inventory_item_nutrition"."sugars_g" IS NULL OR "inventory_item_nutrition"."sugars_g" >= 0) AND ("inventory_item_nutrition"."fibre_g" IS NULL OR "inventory_item_nutrition"."fibre_g" >= 0) AND ("inventory_item_nutrition"."protein_g" IS NULL OR "inventory_item_nutrition"."protein_g" >= 0) AND ("inventory_item_nutrition"."sodium_mg" IS NULL OR "inventory_item_nutrition"."sodium_mg" >= 0))
);
--> statement-breakpoint
CREATE TABLE "menu_item_nutrition" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"menu_item_id" uuid NOT NULL,
	"calories" numeric(14, 4),
	"fat_g" numeric(14, 4),
	"saturated_fat_g" numeric(14, 4),
	"carbohydrate_g" numeric(14, 4),
	"sugars_g" numeric(14, 4),
	"fibre_g" numeric(14, 4),
	"protein_g" numeric(14, 4),
	"sodium_mg" numeric(14, 4),
	"updated_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "menu_item_nutrition_item_unique" UNIQUE("menu_item_id"),
	CONSTRAINT "menu_item_nutrition_figures_non_negative" CHECK (("menu_item_nutrition"."calories" IS NULL OR "menu_item_nutrition"."calories" >= 0) AND ("menu_item_nutrition"."fat_g" IS NULL OR "menu_item_nutrition"."fat_g" >= 0) AND ("menu_item_nutrition"."saturated_fat_g" IS NULL OR "menu_item_nutrition"."saturated_fat_g" >= 0) AND ("menu_item_nutrition"."carbohydrate_g" IS NULL OR "menu_item_nutrition"."carbohydrate_g" >= 0) AND ("menu_item_nutrition"."sugars_g" IS NULL OR "menu_item_nutrition"."sugars_g" >= 0) AND ("menu_item_nutrition"."fibre_g" IS NULL OR "menu_item_nutrition"."fibre_g" >= 0) AND ("menu_item_nutrition"."protein_g" IS NULL OR "menu_item_nutrition"."protein_g" >= 0) AND ("menu_item_nutrition"."sodium_mg" IS NULL OR "menu_item_nutrition"."sodium_mg" >= 0))
);
--> statement-breakpoint
CREATE TABLE "price_period_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"price_period_id" uuid NOT NULL,
	"menu_item_id" uuid NOT NULL,
	"price" numeric(12, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_period_items_period_item_unique" UNIQUE("price_period_id","menu_item_id"),
	CONSTRAINT "price_period_items_price_non_negative" CHECK ("price_period_items"."price" >= 0)
);
--> statement-breakpoint
CREATE TABLE "price_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"name" text NOT NULL,
	"days_of_week" smallint[] NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"order_types" text[],
	"first_date" date,
	"last_date" date,
	"active" boolean DEFAULT true NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"updated_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "price_periods_id_organization_id_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "price_periods_name_valid" CHECK (length(trim("price_periods"."name")) BETWEEN 1 AND 60),
	CONSTRAINT "price_periods_days_valid" CHECK (cardinality("price_periods"."days_of_week") BETWEEN 1 AND 7 AND "price_periods"."days_of_week" <@ ARRAY[0,1,2,3,4,5,6]::smallint[]),
	CONSTRAINT "price_periods_times_differ" CHECK ("price_periods"."start_time" <> "price_periods"."end_time"),
	CONSTRAINT "price_periods_order_types_valid" CHECK ("price_periods"."order_types" IS NULL OR (cardinality("price_periods"."order_types") BETWEEN 1 AND 3 AND "price_periods"."order_types" <@ ARRAY['DINE_IN','BAR','TAKEOUT']::text[])),
	CONSTRAINT "price_periods_dates_ordered" CHECK ("price_periods"."first_date" IS NULL OR "price_periods"."last_date" IS NULL OR "price_periods"."last_date" >= "price_periods"."first_date")
);
--> statement-breakpoint
ALTER TABLE "demand_forecast_hours" DROP CONSTRAINT "demand_forecast_hours_measure_valid";--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "price_period_id" uuid;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "price_period_name_snapshot" text;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "regular_price_snapshot" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "inventory_item_nutrition" ADD CONSTRAINT "inventory_item_nutrition_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_item_nutrition" ADD CONSTRAINT "inventory_item_nutrition_item_org_fk" FOREIGN KEY ("inventory_item_id","organization_id") REFERENCES "public"."inventory_items"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_nutrition" ADD CONSTRAINT "menu_item_nutrition_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_nutrition" ADD CONSTRAINT "menu_item_nutrition_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_nutrition" ADD CONSTRAINT "menu_item_nutrition_item_org_fk" FOREIGN KEY ("menu_item_id","organization_id") REFERENCES "public"."menu_items"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_period_items" ADD CONSTRAINT "price_period_items_period_org_fk" FOREIGN KEY ("price_period_id","organization_id") REFERENCES "public"."price_periods"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_period_items" ADD CONSTRAINT "price_period_items_item_org_fk" FOREIGN KEY ("menu_item_id","organization_id") REFERENCES "public"."menu_items"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_periods" ADD CONSTRAINT "price_periods_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_periods" ADD CONSTRAINT "price_periods_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_periods" ADD CONSTRAINT "price_periods_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_periods" ADD CONSTRAINT "price_periods_location_org_fk" FOREIGN KEY ("location_id","organization_id") REFERENCES "public"."locations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "price_period_items_item_idx" ON "price_period_items" USING btree ("menu_item_id");--> statement-breakpoint
CREATE INDEX "price_periods_location_idx" ON "price_periods" USING btree ("location_id","active");--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_price_period_id_price_periods_id_fk" FOREIGN KEY ("price_period_id") REFERENCES "public"."price_periods"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_price_period_snapshot_fields" CHECK (("order_items"."price_period_id" IS NULL) = ("order_items"."price_period_name_snapshot" IS NULL)
        AND ("order_items"."price_period_id" IS NULL) = ("order_items"."regular_price_snapshot" IS NULL)
        AND ("order_items"."status" <> 'DRAFT' OR "order_items"."price_period_id" IS NULL)
        AND ("order_items"."regular_price_snapshot" IS NULL OR "order_items"."regular_price_snapshot" >= 0));--> statement-breakpoint
ALTER TABLE "demand_forecast_hours" ADD CONSTRAINT "demand_forecast_hours_measure_valid" CHECK ("demand_forecast_hours"."measure" IN ('DINING_COVERS', 'BAR_CHECKS', 'TAKEOUT_CHECKS', 'ALL_CHECKS', 'NET_SALES'));