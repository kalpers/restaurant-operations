ALTER TABLE "locations" ADD CONSTRAINT "locations_id_organization_id_unique" UNIQUE("id","organization_id");--> statement-breakpoint
CREATE TABLE "menu_availability" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"menu_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "menu_availability_interval_valid" CHECK ("menu_availability"."effective_to" IS NULL OR "menu_availability"."effective_to" > "menu_availability"."effective_from")
);
--> statement-breakpoint
CREATE TABLE "menu_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"display_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "menu_categories_organization_id_code_unique" UNIQUE("organization_id","code"),
	CONSTRAINT "menu_categories_id_organization_id_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "menu_categories_code_not_blank" CHECK (length(trim("menu_categories"."code")) > 0),
	CONSTRAINT "menu_categories_name_not_blank" CHECK (length(trim("menu_categories"."name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "menu_item_modifier_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"menu_item_id" uuid NOT NULL,
	"modifier_group_id" uuid NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"required_override" boolean,
	"minimum_override" integer,
	"maximum_override" integer,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "menu_item_modifier_groups_item_group_unique" UNIQUE("menu_item_id","modifier_group_id"),
	CONSTRAINT "menu_item_modifier_groups_minimum_override_valid" CHECK ("menu_item_modifier_groups"."minimum_override" IS NULL OR "menu_item_modifier_groups"."minimum_override" >= 0),
	CONSTRAINT "menu_item_modifier_groups_maximum_override_valid" CHECK ("menu_item_modifier_groups"."maximum_override" IS NULL OR "menu_item_modifier_groups"."maximum_override" >= GREATEST(coalesce("menu_item_modifier_groups"."minimum_override", 0), 1))
);
--> statement-breakpoint
CREATE TABLE "menu_item_placements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"menu_id" uuid NOT NULL,
	"menu_category_id" uuid NOT NULL,
	"menu_item_id" uuid NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "menu_item_placements_menu_category_item_unique" UNIQUE("menu_id","menu_category_id","menu_item_id")
);
--> statement-breakpoint
CREATE TABLE "menu_item_prep_routing" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"menu_item_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"prep_station_id" uuid NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "menu_item_prep_routing_item_location_station_unique" UNIQUE("menu_item_id","location_id","prep_station_id")
);
--> statement-breakpoint
CREATE TABLE "menu_item_prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"menu_item_id" uuid NOT NULL,
	"location_id" uuid,
	"price" numeric(12, 2) NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "menu_item_prices_price_non_negative" CHECK ("menu_item_prices"."price" >= 0),
	CONSTRAINT "menu_item_prices_interval_valid" CHECK ("menu_item_prices"."effective_to" IS NULL OR "menu_item_prices"."effective_to" > "menu_item_prices"."effective_from")
);
--> statement-breakpoint
CREATE TABLE "menu_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"short_name" text,
	"item_type" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"available" boolean DEFAULT true NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "menu_items_organization_id_code_unique" UNIQUE("organization_id","code"),
	CONSTRAINT "menu_items_id_organization_id_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "menu_items_item_type_valid" CHECK ("menu_items"."item_type" IN ('FOOD', 'BEVERAGE', 'ALCOHOL', 'OTHER')),
	CONSTRAINT "menu_items_code_not_blank" CHECK (length(trim("menu_items"."code")) > 0),
	CONSTRAINT "menu_items_name_not_blank" CHECK (length(trim("menu_items"."name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "menu_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"menu_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "menu_locations_menu_id_location_id_unique" UNIQUE("menu_id","location_id")
);
--> statement-breakpoint
CREATE TABLE "menus" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"display_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "menus_organization_id_code_unique" UNIQUE("organization_id","code"),
	CONSTRAINT "menus_id_organization_id_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "menus_code_not_blank" CHECK (length(trim("menus"."code")) > 0),
	CONSTRAINT "menus_name_not_blank" CHECK (length(trim("menus"."name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "modifier_group_modifiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"modifier_group_id" uuid NOT NULL,
	"modifier_id" uuid NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "modifier_group_modifiers_group_modifier_unique" UNIQUE("modifier_group_id","modifier_id")
);
--> statement-breakpoint
CREATE TABLE "modifier_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"selection_type" text NOT NULL,
	"minimum_selections" integer DEFAULT 0 NOT NULL,
	"maximum_selections" integer,
	"display_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "modifier_groups_organization_id_code_unique" UNIQUE("organization_id","code"),
	CONSTRAINT "modifier_groups_id_organization_id_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "modifier_groups_selection_type_valid" CHECK ("modifier_groups"."selection_type" IN ('OPTIONAL_SINGLE', 'REQUIRED_SINGLE', 'OPTIONAL_MULTIPLE', 'REQUIRED_MULTIPLE')),
	CONSTRAINT "modifier_groups_minimum_non_negative" CHECK ("modifier_groups"."minimum_selections" >= 0),
	CONSTRAINT "modifier_groups_maximum_valid" CHECK ("modifier_groups"."maximum_selections" IS NULL OR "modifier_groups"."maximum_selections" >= "modifier_groups"."minimum_selections"),
	CONSTRAINT "modifier_groups_type_matches_counts" CHECK (("modifier_groups"."selection_type" = 'OPTIONAL_SINGLE' AND "modifier_groups"."minimum_selections" = 0 AND "modifier_groups"."maximum_selections" = 1)
        OR ("modifier_groups"."selection_type" = 'REQUIRED_SINGLE' AND "modifier_groups"."minimum_selections" = 1 AND "modifier_groups"."maximum_selections" = 1)
        OR ("modifier_groups"."selection_type" = 'OPTIONAL_MULTIPLE' AND "modifier_groups"."minimum_selections" = 0 AND ("modifier_groups"."maximum_selections" IS NULL OR "modifier_groups"."maximum_selections" >= 1))
        OR ("modifier_groups"."selection_type" = 'REQUIRED_MULTIPLE' AND "modifier_groups"."minimum_selections" >= 1)),
	CONSTRAINT "modifier_groups_code_not_blank" CHECK (length(trim("modifier_groups"."code")) > 0),
	CONSTRAINT "modifier_groups_name_not_blank" CHECK (length(trim("modifier_groups"."name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "modifiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"price_adjustment" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"preparation_effect_type" text DEFAULT 'NONE' NOT NULL,
	"preparation_instruction" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "modifiers_organization_id_code_unique" UNIQUE("organization_id","code"),
	CONSTRAINT "modifiers_id_organization_id_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "modifiers_preparation_effect_valid" CHECK ("modifiers"."preparation_effect_type" IN ('NONE', 'INSTRUCTION', 'ADD_COMPONENT', 'REMOVE_COMPONENT', 'ADJUST_COMPONENT')),
	CONSTRAINT "modifiers_instruction_required" CHECK ("modifiers"."preparation_effect_type" <> 'INSTRUCTION' OR length(trim(coalesce("modifiers"."preparation_instruction", ''))) > 0),
	CONSTRAINT "modifiers_code_not_blank" CHECK (length(trim("modifiers"."code")) > 0),
	CONSTRAINT "modifiers_name_not_blank" CHECK (length(trim("modifiers"."name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "prep_stations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"station_type" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "prep_stations_location_id_code_unique" UNIQUE("location_id","code"),
	CONSTRAINT "prep_stations_id_location_id_unique" UNIQUE("id","location_id"),
	CONSTRAINT "prep_stations_station_type_valid" CHECK ("prep_stations"."station_type" IN ('KITCHEN', 'BAR', 'EXPO')),
	CONSTRAINT "prep_stations_code_not_blank" CHECK (length(trim("prep_stations"."code")) > 0),
	CONSTRAINT "prep_stations_name_not_blank" CHECK (length(trim("prep_stations"."name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "recipe_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipe_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"yield_quantity" numeric(14, 4) NOT NULL,
	"yield_unit_id" uuid,
	"preparation_notes" text,
	"effective_from" timestamp with time zone,
	"effective_to" timestamp with time zone,
	"created_by_user_id" uuid NOT NULL,
	"published_by_user_id" uuid,
	"published_at" timestamp with time zone,
	"retired_by_user_id" uuid,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "recipe_versions_recipe_id_revision_number_unique" UNIQUE("recipe_id","revision_number"),
	CONSTRAINT "recipe_versions_revision_positive" CHECK ("recipe_versions"."revision_number" > 0),
	CONSTRAINT "recipe_versions_status_valid" CHECK ("recipe_versions"."status" IN ('DRAFT', 'PUBLISHED', 'RETIRED')),
	CONSTRAINT "recipe_versions_yield_positive" CHECK ("recipe_versions"."yield_quantity" > 0),
	CONSTRAINT "recipe_versions_interval_matches_status" CHECK (("recipe_versions"."status" = 'DRAFT' AND "recipe_versions"."effective_from" IS NULL AND "recipe_versions"."effective_to" IS NULL)
        OR ("recipe_versions"."status" = 'PUBLISHED' AND "recipe_versions"."effective_from" IS NOT NULL AND ("recipe_versions"."effective_to" IS NULL OR "recipe_versions"."effective_to" > "recipe_versions"."effective_from"))
        OR ("recipe_versions"."status" = 'RETIRED' AND "recipe_versions"."effective_from" IS NOT NULL AND "recipe_versions"."effective_to" IS NOT NULL AND "recipe_versions"."effective_to" >= "recipe_versions"."effective_from"))
);
--> statement-breakpoint
CREATE TABLE "recipes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"menu_item_id" uuid,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "recipes_organization_id_code_unique" UNIQUE("organization_id","code"),
	CONSTRAINT "recipes_id_organization_id_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "recipes_code_not_blank" CHECK (length(trim("recipes"."code")) > 0),
	CONSTRAINT "recipes_name_not_blank" CHECK (length(trim("recipes"."name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "unit_conversions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_unit_id" uuid NOT NULL,
	"to_unit_id" uuid NOT NULL,
	"measurement_type" text NOT NULL,
	"factor" numeric(14, 6) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "unit_conversions_from_to_unique" UNIQUE("from_unit_id","to_unit_id"),
	CONSTRAINT "unit_conversions_factor_positive" CHECK ("unit_conversions"."factor" > 0),
	CONSTRAINT "unit_conversions_distinct_units" CHECK ("unit_conversions"."from_unit_id" <> "unit_conversions"."to_unit_id")
);
--> statement-breakpoint
CREATE TABLE "units_of_measure" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"measurement_type" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "units_of_measure_code_unique" UNIQUE("code"),
	CONSTRAINT "units_of_measure_id_measurement_type_unique" UNIQUE("id","measurement_type"),
	CONSTRAINT "units_of_measure_measurement_type_valid" CHECK ("units_of_measure"."measurement_type" IN ('COUNT', 'WEIGHT', 'VOLUME')),
	CONSTRAINT "units_of_measure_code_not_ambiguous" CHECK ("units_of_measure"."code" <> 'OZ')
);
--> statement-breakpoint
ALTER TABLE "menu_availability" ADD CONSTRAINT "menu_availability_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_availability" ADD CONSTRAINT "menu_availability_menu_location_fk" FOREIGN KEY ("menu_id","location_id") REFERENCES "public"."menu_locations"("menu_id","location_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_categories" ADD CONSTRAINT "menu_categories_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_modifier_groups" ADD CONSTRAINT "menu_item_modifier_groups_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_modifier_groups" ADD CONSTRAINT "menu_item_modifier_groups_item_org_fk" FOREIGN KEY ("menu_item_id","organization_id") REFERENCES "public"."menu_items"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_modifier_groups" ADD CONSTRAINT "menu_item_modifier_groups_group_org_fk" FOREIGN KEY ("modifier_group_id","organization_id") REFERENCES "public"."modifier_groups"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_placements" ADD CONSTRAINT "menu_item_placements_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_placements" ADD CONSTRAINT "menu_item_placements_menu_org_fk" FOREIGN KEY ("menu_id","organization_id") REFERENCES "public"."menus"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_placements" ADD CONSTRAINT "menu_item_placements_category_org_fk" FOREIGN KEY ("menu_category_id","organization_id") REFERENCES "public"."menu_categories"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_placements" ADD CONSTRAINT "menu_item_placements_item_org_fk" FOREIGN KEY ("menu_item_id","organization_id") REFERENCES "public"."menu_items"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_prep_routing" ADD CONSTRAINT "menu_item_prep_routing_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_prep_routing" ADD CONSTRAINT "menu_item_prep_routing_item_org_fk" FOREIGN KEY ("menu_item_id","organization_id") REFERENCES "public"."menu_items"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_prep_routing" ADD CONSTRAINT "menu_item_prep_routing_location_org_fk" FOREIGN KEY ("location_id","organization_id") REFERENCES "public"."locations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_prep_routing" ADD CONSTRAINT "menu_item_prep_routing_station_location_fk" FOREIGN KEY ("prep_station_id","location_id") REFERENCES "public"."prep_stations"("id","location_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_prices" ADD CONSTRAINT "menu_item_prices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_prices" ADD CONSTRAINT "menu_item_prices_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_prices" ADD CONSTRAINT "menu_item_prices_item_org_fk" FOREIGN KEY ("menu_item_id","organization_id") REFERENCES "public"."menu_items"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_prices" ADD CONSTRAINT "menu_item_prices_location_org_fk" FOREIGN KEY ("location_id","organization_id") REFERENCES "public"."locations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_locations" ADD CONSTRAINT "menu_locations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_locations" ADD CONSTRAINT "menu_locations_menu_org_fk" FOREIGN KEY ("menu_id","organization_id") REFERENCES "public"."menus"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_locations" ADD CONSTRAINT "menu_locations_location_org_fk" FOREIGN KEY ("location_id","organization_id") REFERENCES "public"."locations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menus" ADD CONSTRAINT "menus_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modifier_group_modifiers" ADD CONSTRAINT "modifier_group_modifiers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modifier_group_modifiers" ADD CONSTRAINT "modifier_group_modifiers_group_org_fk" FOREIGN KEY ("modifier_group_id","organization_id") REFERENCES "public"."modifier_groups"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modifier_group_modifiers" ADD CONSTRAINT "modifier_group_modifiers_modifier_org_fk" FOREIGN KEY ("modifier_id","organization_id") REFERENCES "public"."modifiers"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modifier_groups" ADD CONSTRAINT "modifier_groups_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modifiers" ADD CONSTRAINT "modifiers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prep_stations" ADD CONSTRAINT "prep_stations_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_versions" ADD CONSTRAINT "recipe_versions_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_versions" ADD CONSTRAINT "recipe_versions_yield_unit_id_units_of_measure_id_fk" FOREIGN KEY ("yield_unit_id") REFERENCES "public"."units_of_measure"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_versions" ADD CONSTRAINT "recipe_versions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_versions" ADD CONSTRAINT "recipe_versions_published_by_user_id_users_id_fk" FOREIGN KEY ("published_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_versions" ADD CONSTRAINT "recipe_versions_retired_by_user_id_users_id_fk" FOREIGN KEY ("retired_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_menu_item_org_fk" FOREIGN KEY ("menu_item_id","organization_id") REFERENCES "public"."menu_items"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_conversions" ADD CONSTRAINT "unit_conversions_from_unit_type_fk" FOREIGN KEY ("from_unit_id","measurement_type") REFERENCES "public"."units_of_measure"("id","measurement_type") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_conversions" ADD CONSTRAINT "unit_conversions_to_unit_type_fk" FOREIGN KEY ("to_unit_id","measurement_type") REFERENCES "public"."units_of_measure"("id","measurement_type") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "menu_availability_menu_id_location_id_idx" ON "menu_availability" USING btree ("menu_id","location_id");--> statement-breakpoint
CREATE INDEX "menu_item_modifier_groups_group_id_idx" ON "menu_item_modifier_groups" USING btree ("modifier_group_id");--> statement-breakpoint
CREATE INDEX "menu_item_placements_menu_item_id_idx" ON "menu_item_placements" USING btree ("menu_item_id");--> statement-breakpoint
CREATE INDEX "menu_item_prep_routing_station_idx" ON "menu_item_prep_routing" USING btree ("prep_station_id");--> statement-breakpoint
CREATE INDEX "menu_item_prices_item_location_from_idx" ON "menu_item_prices" USING btree ("menu_item_id","location_id","effective_from");--> statement-breakpoint
CREATE INDEX "menu_locations_location_id_idx" ON "menu_locations" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "modifier_group_modifiers_modifier_id_idx" ON "modifier_group_modifiers" USING btree ("modifier_id");--> statement-breakpoint
CREATE INDEX "recipe_versions_recipe_id_effective_from_idx" ON "recipe_versions" USING btree ("recipe_id","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "recipes_menu_item_id_unique" ON "recipes" USING btree ("menu_item_id") WHERE "recipes"."menu_item_id" IS NOT NULL;
