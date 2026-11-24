CREATE TABLE "menu_item_bundle_slot_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"slot_id" uuid NOT NULL,
	"component_menu_item_id" uuid NOT NULL,
	"upcharge" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "menu_item_bundle_slot_options_slot_component_unique" UNIQUE("slot_id","component_menu_item_id"),
	CONSTRAINT "menu_item_bundle_slot_options_upcharge_valid" CHECK ("menu_item_bundle_slot_options"."upcharge" >= 0)
);
--> statement-breakpoint
CREATE TABLE "menu_item_bundle_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"bundle_menu_item_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"default_course" integer DEFAULT 1 NOT NULL,
	"minimum_choices" integer DEFAULT 1 NOT NULL,
	"maximum_choices" integer DEFAULT 1 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "menu_item_bundle_slots_name_length" CHECK (char_length("menu_item_bundle_slots"."name") BETWEEN 1 AND 60),
	CONSTRAINT "menu_item_bundle_slots_course_range" CHECK ("menu_item_bundle_slots"."default_course" BETWEEN 1 AND 5),
	CONSTRAINT "menu_item_bundle_slots_choices_valid" CHECK ("menu_item_bundle_slots"."minimum_choices" >= 0 AND "menu_item_bundle_slots"."maximum_choices" >= 1 AND "menu_item_bundle_slots"."maximum_choices" >= "menu_item_bundle_slots"."minimum_choices" AND "menu_item_bundle_slots"."maximum_choices" <= 10)
);
--> statement-breakpoint
ALTER TABLE "menu_items" ADD COLUMN "item_kind" text DEFAULT 'STANDARD' NOT NULL;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "bundle_parent_order_item_id" uuid;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "bundle_slot_id" uuid;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "bundle_slot_name_snapshot" text;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "bundle_name_snapshot" text;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "bundle_upcharge_snapshot" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "menu_item_bundle_slot_options" ADD CONSTRAINT "menu_item_bundle_slot_options_org_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_bundle_slot_options" ADD CONSTRAINT "menu_item_bundle_slot_options_slot_fk" FOREIGN KEY ("slot_id") REFERENCES "public"."menu_item_bundle_slots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_bundle_slot_options" ADD CONSTRAINT "menu_item_bundle_slot_options_component_fk" FOREIGN KEY ("component_menu_item_id","organization_id") REFERENCES "public"."menu_items"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_bundle_slots" ADD CONSTRAINT "menu_item_bundle_slots_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_bundle_slots" ADD CONSTRAINT "menu_item_bundle_slots_bundle_fk" FOREIGN KEY ("bundle_menu_item_id","organization_id") REFERENCES "public"."menu_items"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "menu_item_bundle_slot_options_slot_idx" ON "menu_item_bundle_slot_options" USING btree ("slot_id","sort_order");--> statement-breakpoint
CREATE INDEX "menu_item_bundle_slot_options_component_idx" ON "menu_item_bundle_slot_options" USING btree ("component_menu_item_id");--> statement-breakpoint
CREATE INDEX "menu_item_bundle_slots_bundle_idx" ON "menu_item_bundle_slots" USING btree ("bundle_menu_item_id","sort_order");--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_bundle_parent_fk" FOREIGN KEY ("bundle_parent_order_item_id") REFERENCES "public"."order_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_bundle_slot_fk" FOREIGN KEY ("bundle_slot_id") REFERENCES "public"."menu_item_bundle_slots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_items_bundle_parent_idx" ON "order_items" USING btree ("bundle_parent_order_item_id");--> statement-breakpoint
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_item_kind_valid" CHECK ("menu_items"."item_kind" IN ('STANDARD', 'BUNDLE'));--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_bundle_component_fields" CHECK ((("order_items"."bundle_parent_order_item_id" IS NULL) = ("order_items"."bundle_slot_id" IS NULL)
          AND ("order_items"."bundle_parent_order_item_id" IS NULL) = ("order_items"."bundle_slot_name_snapshot" IS NULL)
          AND ("order_items"."bundle_parent_order_item_id" IS NULL) = ("order_items"."bundle_name_snapshot" IS NULL)
          AND ("order_items"."bundle_parent_order_item_id" IS NULL) = ("order_items"."bundle_upcharge_snapshot" IS NULL))
        AND ("order_items"."bundle_parent_order_item_id" IS NULL OR ("order_items"."base_price_snapshot" = 0 AND "order_items"."modifier_total_snapshot" = 0
          AND "order_items"."line_total_snapshot" = 0 AND "order_items"."bundle_upcharge_snapshot" >= 0 AND "order_items"."tax_category_id" IS NULL))
        AND ("order_items"."bundle_parent_order_item_id" IS NULL OR "order_items"."bundle_parent_order_item_id" <> "order_items"."id"));