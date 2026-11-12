CREATE TABLE "allergens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "allergens_organization_id_code_unique" UNIQUE("organization_id","code"),
	CONSTRAINT "allergens_id_organization_id_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "allergens_code_format" CHECK ("allergens"."code" ~ '^[A-Z][A-Z0-9_]{0,39}$'),
	CONSTRAINT "allergens_name_valid" CHECK (length(trim("allergens"."name")) BETWEEN 1 AND 60)
);
--> statement-breakpoint
CREATE TABLE "ingredient_allergen_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"inventory_item_id" uuid NOT NULL,
	"reviewed_at" timestamp with time zone NOT NULL,
	"reviewed_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "ingredient_allergen_reviews_item_unique" UNIQUE("inventory_item_id")
);
--> statement-breakpoint
CREATE TABLE "inventory_item_allergens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"inventory_item_id" uuid NOT NULL,
	"allergen_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_item_allergens_item_allergen_unique" UNIQUE("inventory_item_id","allergen_id")
);
--> statement-breakpoint
CREATE TABLE "menu_item_allergen_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"menu_item_id" uuid NOT NULL,
	"reviewed_at" timestamp with time zone NOT NULL,
	"reviewed_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "menu_item_allergen_reviews_item_unique" UNIQUE("menu_item_id")
);
--> statement-breakpoint
CREATE TABLE "menu_item_allergens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"menu_item_id" uuid NOT NULL,
	"allergen_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "menu_item_allergens_item_allergen_unique" UNIQUE("menu_item_id","allergen_id"),
	CONSTRAINT "menu_item_allergens_kind_valid" CHECK ("menu_item_allergens"."kind" IN ('CONTAINS', 'MAY_CONTAIN'))
);
--> statement-breakpoint
ALTER TABLE "allergens" ADD CONSTRAINT "allergens_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingredient_allergen_reviews" ADD CONSTRAINT "ingredient_allergen_reviews_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingredient_allergen_reviews" ADD CONSTRAINT "ingredient_allergen_reviews_item_org_fk" FOREIGN KEY ("inventory_item_id","organization_id") REFERENCES "public"."inventory_items"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_item_allergens" ADD CONSTRAINT "inventory_item_allergens_item_org_fk" FOREIGN KEY ("inventory_item_id","organization_id") REFERENCES "public"."inventory_items"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_item_allergens" ADD CONSTRAINT "inventory_item_allergens_allergen_org_fk" FOREIGN KEY ("allergen_id","organization_id") REFERENCES "public"."allergens"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_allergen_reviews" ADD CONSTRAINT "menu_item_allergen_reviews_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_allergen_reviews" ADD CONSTRAINT "menu_item_allergen_reviews_item_org_fk" FOREIGN KEY ("menu_item_id","organization_id") REFERENCES "public"."menu_items"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_allergens" ADD CONSTRAINT "menu_item_allergens_item_org_fk" FOREIGN KEY ("menu_item_id","organization_id") REFERENCES "public"."menu_items"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_allergens" ADD CONSTRAINT "menu_item_allergens_allergen_org_fk" FOREIGN KEY ("allergen_id","organization_id") REFERENCES "public"."allergens"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "menu_item_allergens_allergen_idx" ON "menu_item_allergens" USING btree ("allergen_id");