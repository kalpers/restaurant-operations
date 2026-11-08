CREATE TABLE "inventory_balances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"inventory_item_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"quantity_on_hand" numeric(14, 4) DEFAULT '0' NOT NULL,
	"weighted_average_cost" numeric(14, 4),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "inventory_balances_item_location_unique" UNIQUE("inventory_item_id","location_id"),
	CONSTRAINT "inventory_balances_cost_non_negative" CHECK ("inventory_balances"."weighted_average_cost" IS NULL OR "inventory_balances"."weighted_average_cost" >= 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_count_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"inventory_count_id" uuid NOT NULL,
	"inventory_item_id" uuid NOT NULL,
	"unit_of_measure_id" uuid NOT NULL,
	"expected_quantity" numeric(14, 4) NOT NULL,
	"snapshot_sequence" bigint NOT NULL,
	"snapshot_at" timestamp with time zone NOT NULL,
	"counted_quantity" numeric(14, 4),
	"variance_quantity" numeric(14, 4),
	"notes" text,
	"inventory_transaction_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "inventory_count_lines_count_item_unique" UNIQUE("inventory_count_id","inventory_item_id"),
	CONSTRAINT "inventory_count_lines_counted_non_negative" CHECK ("inventory_count_lines"."counted_quantity" IS NULL OR "inventory_count_lines"."counted_quantity" >= 0),
	CONSTRAINT "inventory_count_lines_variance_matches" CHECK (("inventory_count_lines"."counted_quantity" IS NULL AND "inventory_count_lines"."variance_quantity" IS NULL) OR "inventory_count_lines"."variance_quantity" = "inventory_count_lines"."counted_quantity" - "inventory_count_lines"."expected_quantity")
);
--> statement-breakpoint
CREATE TABLE "inventory_counts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"notes" text,
	"started_by_user_id" uuid NOT NULL,
	"counted_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"submitted_by_user_id" uuid,
	"approved_at" timestamp with time zone,
	"approved_by_user_id" uuid,
	"activity_acknowledged_at" timestamp with time zone,
	"activity_acknowledged_by_user_id" uuid,
	"cancelled_at" timestamp with time zone,
	"cancelled_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "inventory_counts_status_valid" CHECK ("inventory_counts"."status" IN ('DRAFT', 'SUBMITTED', 'APPROVED', 'CANCELLED')),
	CONSTRAINT "inventory_counts_approval_recorded" CHECK ("inventory_counts"."status" <> 'APPROVED' OR ("inventory_counts"."approved_at" IS NOT NULL AND "inventory_counts"."approved_by_user_id" IS NOT NULL)),
	CONSTRAINT "inventory_counts_acknowledgement_pair" CHECK (("inventory_counts"."activity_acknowledged_at" IS NULL) = ("inventory_counts"."activity_acknowledged_by_user_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "inventory_item_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"inventory_item_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"par_level" numeric(14, 4),
	"reorder_level" numeric(14, 4),
	"reorder_target" numeric(14, 4),
	"storage_note" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "inventory_item_locations_item_location_unique" UNIQUE("inventory_item_id","location_id"),
	CONSTRAINT "inventory_item_locations_levels_non_negative" CHECK (coalesce("inventory_item_locations"."par_level", 0) >= 0 AND coalesce("inventory_item_locations"."reorder_level", 0) >= 0 AND coalesce("inventory_item_locations"."reorder_target", 0) >= 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_item_unit_conversions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"inventory_item_id" uuid NOT NULL,
	"from_unit_id" uuid NOT NULL,
	"to_unit_id" uuid NOT NULL,
	"factor" numeric(14, 6) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "inventory_item_unit_conversions_factor_positive" CHECK ("inventory_item_unit_conversions"."factor" > 0),
	CONSTRAINT "inventory_item_unit_conversions_distinct_units" CHECK ("inventory_item_unit_conversions"."from_unit_id" <> "inventory_item_unit_conversions"."to_unit_id")
);
--> statement-breakpoint
CREATE TABLE "inventory_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"measurement_type" text NOT NULL,
	"base_unit_id" uuid NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "inventory_items_organization_id_code_unique" UNIQUE("organization_id","code"),
	CONSTRAINT "inventory_items_id_organization_id_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "inventory_items_id_base_unit_id_unique" UNIQUE("id","base_unit_id"),
	CONSTRAINT "inventory_items_code_not_blank" CHECK (length(trim("inventory_items"."code")) > 0),
	CONSTRAINT "inventory_items_name_not_blank" CHECK (length(trim("inventory_items"."name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" bigint GENERATED ALWAYS AS IDENTITY (sequence name "inventory_transactions_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"inventory_item_id" uuid NOT NULL,
	"transaction_type" text NOT NULL,
	"quantity" numeric(14, 4) NOT NULL,
	"unit_of_measure_id" uuid NOT NULL,
	"base_quantity_delta" numeric(14, 4) NOT NULL,
	"unit_cost" numeric(14, 4),
	"total_cost" numeric(14, 4),
	"quantity_after" numeric(14, 4) NOT NULL,
	"average_cost_after" numeric(14, 4),
	"business_date" date NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"reference_type" text,
	"reference_id" uuid,
	"reason_code" text,
	"notes" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_transactions_sequence_unique" UNIQUE("sequence"),
	CONSTRAINT "inventory_transactions_type_valid" CHECK ("inventory_transactions"."transaction_type" IN ('RECEIVE', 'CONSUME', 'WASTE', 'ADJUST_INCREASE', 'ADJUST_DECREASE', 'COUNT_INCREASE', 'COUNT_DECREASE', 'TRANSFER_OUT', 'TRANSFER_IN')),
	CONSTRAINT "inventory_transactions_direction_matches_type" CHECK (("inventory_transactions"."transaction_type" IN ('RECEIVE', 'ADJUST_INCREASE', 'COUNT_INCREASE', 'TRANSFER_IN') AND "inventory_transactions"."base_quantity_delta" > 0 AND "inventory_transactions"."quantity" > 0)
        OR ("inventory_transactions"."transaction_type" IN ('CONSUME', 'WASTE', 'ADJUST_DECREASE', 'COUNT_DECREASE', 'TRANSFER_OUT') AND "inventory_transactions"."base_quantity_delta" < 0 AND "inventory_transactions"."quantity" < 0)),
	CONSTRAINT "inventory_transactions_reason_required" CHECK ("inventory_transactions"."transaction_type" NOT IN ('WASTE', 'ADJUST_INCREASE', 'ADJUST_DECREASE') OR "inventory_transactions"."reason_code" IS NOT NULL),
	CONSTRAINT "inventory_transactions_reference_pair" CHECK (("inventory_transactions"."reference_type" IS NULL) = ("inventory_transactions"."reference_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "purchase_order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"supplier_item_id" uuid NOT NULL,
	"inventory_item_id" uuid NOT NULL,
	"purchase_unit_id" uuid NOT NULL,
	"base_units_per_purchase" numeric(14, 4) NOT NULL,
	"ordered_quantity" numeric(14, 4) NOT NULL,
	"unit_price" numeric(14, 4) NOT NULL,
	"line_total" numeric(14, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "purchase_order_lines_order_supplier_item_unique" UNIQUE("purchase_order_id","supplier_item_id"),
	CONSTRAINT "purchase_order_lines_quantity_positive" CHECK ("purchase_order_lines"."ordered_quantity" > 0),
	CONSTRAINT "purchase_order_lines_price_non_negative" CHECK ("purchase_order_lines"."unit_price" >= 0),
	CONSTRAINT "purchase_order_lines_base_units_positive" CHECK ("purchase_order_lines"."base_units_per_purchase" > 0)
);
--> statement-breakpoint
CREATE TABLE "purchase_order_receipt_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"receipt_id" uuid NOT NULL,
	"purchase_order_line_id" uuid NOT NULL,
	"received_quantity" numeric(14, 4) NOT NULL,
	"purchase_unit_id" uuid NOT NULL,
	"actual_unit_cost" numeric(14, 4) NOT NULL,
	"base_quantity" numeric(14, 4) NOT NULL,
	"base_unit_cost" numeric(14, 4) NOT NULL,
	"total_cost" numeric(14, 4) NOT NULL,
	"inventory_transaction_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_order_receipt_lines_quantity_positive" CHECK ("purchase_order_receipt_lines"."received_quantity" > 0),
	CONSTRAINT "purchase_order_receipt_lines_cost_non_negative" CHECK ("purchase_order_receipt_lines"."actual_unit_cost" >= 0)
);
--> statement-breakpoint
CREATE TABLE "purchase_order_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"business_date" date NOT NULL,
	"received_by_user_id" uuid NOT NULL,
	"supplier_reference" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"sequence_number" integer NOT NULL,
	"po_number" text NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"expected_at" timestamp with time zone,
	"notes" text,
	"created_by_user_id" uuid NOT NULL,
	"submitted_at" timestamp with time zone,
	"submitted_by_user_id" uuid,
	"cancelled_at" timestamp with time zone,
	"cancelled_by_user_id" uuid,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "purchase_orders_location_po_number_unique" UNIQUE("location_id","po_number"),
	CONSTRAINT "purchase_orders_location_sequence_unique" UNIQUE("location_id","sequence_number"),
	CONSTRAINT "purchase_orders_status_valid" CHECK ("purchase_orders"."status" IN ('DRAFT', 'SUBMITTED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED')),
	CONSTRAINT "purchase_orders_submission_recorded" CHECK ("purchase_orders"."status" IN ('DRAFT') OR ("purchase_orders"."status" = 'CANCELLED' AND "purchase_orders"."submitted_at" IS NULL) OR ("purchase_orders"."submitted_at" IS NOT NULL AND "purchase_orders"."submitted_by_user_id" IS NOT NULL)),
	CONSTRAINT "purchase_orders_cancellation_recorded" CHECK ("purchase_orders"."status" <> 'CANCELLED' OR ("purchase_orders"."cancelled_at" IS NOT NULL AND "purchase_orders"."cancelled_by_user_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "supplier_item_cost_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"supplier_item_id" uuid NOT NULL,
	"unit_cost" numeric(14, 4) NOT NULL,
	"source" text NOT NULL,
	"receipt_line_id" uuid,
	"recorded_by_user_id" uuid,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_item_cost_history_source_valid" CHECK ("supplier_item_cost_history"."source" IN ('MANUAL', 'RECEIPT')),
	CONSTRAINT "supplier_item_cost_history_cost_non_negative" CHECK ("supplier_item_cost_history"."unit_cost" >= 0)
);
--> statement-breakpoint
CREATE TABLE "supplier_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"inventory_item_id" uuid NOT NULL,
	"supplier_sku" text,
	"purchase_unit_id" uuid NOT NULL,
	"base_units_per_purchase" numeric(14, 4) NOT NULL,
	"last_unit_cost" numeric(14, 4),
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "supplier_items_supplier_item_unit_unique" UNIQUE("supplier_id","inventory_item_id","purchase_unit_id"),
	CONSTRAINT "supplier_items_id_supplier_id_unique" UNIQUE("id","supplier_id"),
	CONSTRAINT "supplier_items_base_units_positive" CHECK ("supplier_items"."base_units_per_purchase" > 0),
	CONSTRAINT "supplier_items_last_cost_non_negative" CHECK ("supplier_items"."last_unit_cost" IS NULL OR "supplier_items"."last_unit_cost" >= 0)
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"contact_name" text,
	"phone" text,
	"email" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "suppliers_organization_id_code_unique" UNIQUE("organization_id","code"),
	CONSTRAINT "suppliers_id_organization_id_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "suppliers_code_not_blank" CHECK (length(trim("suppliers"."code")) > 0),
	CONSTRAINT "suppliers_name_not_blank" CHECK (length(trim("suppliers"."name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "modifier_inventory_effects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"modifier_id" uuid NOT NULL,
	"menu_item_id" uuid NOT NULL,
	"inventory_item_id" uuid NOT NULL,
	"effect_type" text NOT NULL,
	"quantity" numeric(14, 4),
	"unit_of_measure_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "modifier_inventory_effects_modifier_menu_item_item_unique" UNIQUE("modifier_id","menu_item_id","inventory_item_id"),
	CONSTRAINT "modifier_inventory_effects_shape" CHECK (("modifier_inventory_effects"."effect_type" = 'ADD' AND "modifier_inventory_effects"."quantity" > 0 AND "modifier_inventory_effects"."unit_of_measure_id" IS NOT NULL)
        OR ("modifier_inventory_effects"."effect_type" = 'REMOVE' AND "modifier_inventory_effects"."quantity" IS NULL AND "modifier_inventory_effects"."unit_of_measure_id" IS NULL)
        OR ("modifier_inventory_effects"."effect_type" = 'ADJUST' AND "modifier_inventory_effects"."quantity" <> 0 AND "modifier_inventory_effects"."unit_of_measure_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "recipe_version_ingredients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"recipe_version_id" uuid NOT NULL,
	"inventory_item_id" uuid NOT NULL,
	"quantity" numeric(14, 4) NOT NULL,
	"unit_of_measure_id" uuid NOT NULL,
	"preparation_note" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recipe_version_ingredients_version_item_unique" UNIQUE("recipe_version_id","inventory_item_id"),
	CONSTRAINT "recipe_version_ingredients_quantity_positive" CHECK ("recipe_version_ingredients"."quantity" > 0)
);
--> statement-breakpoint
ALTER TABLE "location_settings" ADD COLUMN "allow_negative_inventory" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_balances" ADD CONSTRAINT "inventory_balances_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_balances" ADD CONSTRAINT "inventory_balances_item_org_fk" FOREIGN KEY ("inventory_item_id","organization_id") REFERENCES "public"."inventory_items"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_balances" ADD CONSTRAINT "inventory_balances_location_org_fk" FOREIGN KEY ("location_id","organization_id") REFERENCES "public"."locations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_count_lines" ADD CONSTRAINT "inventory_count_lines_count_fk" FOREIGN KEY ("inventory_count_id") REFERENCES "public"."inventory_counts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_count_lines" ADD CONSTRAINT "inventory_count_lines_item_fk" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."inventory_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_count_lines" ADD CONSTRAINT "inventory_count_lines_unit_fk" FOREIGN KEY ("unit_of_measure_id") REFERENCES "public"."units_of_measure"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_count_lines" ADD CONSTRAINT "inventory_count_lines_transaction_fk" FOREIGN KEY ("inventory_transaction_id") REFERENCES "public"."inventory_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_counts" ADD CONSTRAINT "inventory_counts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_counts" ADD CONSTRAINT "inventory_counts_started_by_user_id_users_id_fk" FOREIGN KEY ("started_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_counts" ADD CONSTRAINT "inventory_counts_submitted_by_user_id_users_id_fk" FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_counts" ADD CONSTRAINT "inventory_counts_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_counts" ADD CONSTRAINT "inventory_counts_activity_acknowledged_by_user_id_users_id_fk" FOREIGN KEY ("activity_acknowledged_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_counts" ADD CONSTRAINT "inventory_counts_cancelled_by_user_id_users_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_counts" ADD CONSTRAINT "inventory_counts_location_org_fk" FOREIGN KEY ("location_id","organization_id") REFERENCES "public"."locations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_item_locations" ADD CONSTRAINT "inventory_item_locations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_item_locations" ADD CONSTRAINT "inventory_item_locations_item_org_fk" FOREIGN KEY ("inventory_item_id","organization_id") REFERENCES "public"."inventory_items"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_item_locations" ADD CONSTRAINT "inventory_item_locations_location_org_fk" FOREIGN KEY ("location_id","organization_id") REFERENCES "public"."locations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_item_unit_conversions" ADD CONSTRAINT "inventory_item_unit_conversions_item_fk" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."inventory_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_item_unit_conversions" ADD CONSTRAINT "inventory_item_unit_conversions_from_unit_fk" FOREIGN KEY ("from_unit_id") REFERENCES "public"."units_of_measure"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_item_unit_conversions" ADD CONSTRAINT "inventory_item_unit_conversions_to_unit_fk" FOREIGN KEY ("to_unit_id") REFERENCES "public"."units_of_measure"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_base_unit_type_fk" FOREIGN KEY ("base_unit_id","measurement_type") REFERENCES "public"."units_of_measure"("id","measurement_type") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_unit_fk" FOREIGN KEY ("unit_of_measure_id") REFERENCES "public"."units_of_measure"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_created_by_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_item_org_fk" FOREIGN KEY ("inventory_item_id","organization_id") REFERENCES "public"."inventory_items"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_location_org_fk" FOREIGN KEY ("location_id","organization_id") REFERENCES "public"."locations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_order_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_supplier_item_fk" FOREIGN KEY ("supplier_item_id") REFERENCES "public"."supplier_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_item_fk" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."inventory_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_unit_fk" FOREIGN KEY ("purchase_unit_id") REFERENCES "public"."units_of_measure"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_receipt_lines" ADD CONSTRAINT "purchase_order_receipt_lines_receipt_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."purchase_order_receipts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_receipt_lines" ADD CONSTRAINT "purchase_order_receipt_lines_order_line_fk" FOREIGN KEY ("purchase_order_line_id") REFERENCES "public"."purchase_order_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_receipt_lines" ADD CONSTRAINT "purchase_order_receipt_lines_unit_fk" FOREIGN KEY ("purchase_unit_id") REFERENCES "public"."units_of_measure"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_receipt_lines" ADD CONSTRAINT "purchase_order_receipt_lines_transaction_fk" FOREIGN KEY ("inventory_transaction_id") REFERENCES "public"."inventory_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_submitted_by_user_id_users_id_fk" FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_cancelled_by_user_id_users_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_supplier_org_fk" FOREIGN KEY ("supplier_id","organization_id") REFERENCES "public"."suppliers"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_location_org_fk" FOREIGN KEY ("location_id","organization_id") REFERENCES "public"."locations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_item_cost_history" ADD CONSTRAINT "supplier_item_cost_history_supplier_item_fk" FOREIGN KEY ("supplier_item_id") REFERENCES "public"."supplier_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_item_cost_history" ADD CONSTRAINT "supplier_item_cost_history_recorded_by_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_items" ADD CONSTRAINT "supplier_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_items" ADD CONSTRAINT "supplier_items_purchase_unit_id_units_of_measure_id_fk" FOREIGN KEY ("purchase_unit_id") REFERENCES "public"."units_of_measure"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_items" ADD CONSTRAINT "supplier_items_supplier_org_fk" FOREIGN KEY ("supplier_id","organization_id") REFERENCES "public"."suppliers"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_items" ADD CONSTRAINT "supplier_items_item_org_fk" FOREIGN KEY ("inventory_item_id","organization_id") REFERENCES "public"."inventory_items"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modifier_inventory_effects" ADD CONSTRAINT "modifier_inventory_effects_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modifier_inventory_effects" ADD CONSTRAINT "modifier_inventory_effects_unit_fk" FOREIGN KEY ("unit_of_measure_id") REFERENCES "public"."units_of_measure"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modifier_inventory_effects" ADD CONSTRAINT "modifier_inventory_effects_modifier_org_fk" FOREIGN KEY ("modifier_id","organization_id") REFERENCES "public"."modifiers"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modifier_inventory_effects" ADD CONSTRAINT "modifier_inventory_effects_menu_item_org_fk" FOREIGN KEY ("menu_item_id","organization_id") REFERENCES "public"."menu_items"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modifier_inventory_effects" ADD CONSTRAINT "modifier_inventory_effects_item_org_fk" FOREIGN KEY ("inventory_item_id","organization_id") REFERENCES "public"."inventory_items"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_version_ingredients" ADD CONSTRAINT "recipe_version_ingredients_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_version_ingredients" ADD CONSTRAINT "recipe_version_ingredients_version_fk" FOREIGN KEY ("recipe_version_id") REFERENCES "public"."recipe_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_version_ingredients" ADD CONSTRAINT "recipe_version_ingredients_unit_fk" FOREIGN KEY ("unit_of_measure_id") REFERENCES "public"."units_of_measure"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_version_ingredients" ADD CONSTRAINT "recipe_version_ingredients_item_org_fk" FOREIGN KEY ("inventory_item_id","organization_id") REFERENCES "public"."inventory_items"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inventory_counts_location_status_idx" ON "inventory_counts" USING btree ("location_id","status");--> statement-breakpoint
CREATE INDEX "inventory_item_locations_location_id_idx" ON "inventory_item_locations" USING btree ("location_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_item_unit_conversions_one_active_from" ON "inventory_item_unit_conversions" USING btree ("inventory_item_id","from_unit_id") WHERE "inventory_item_unit_conversions"."active";--> statement-breakpoint
CREATE INDEX "inventory_transactions_item_location_sequence_idx" ON "inventory_transactions" USING btree ("inventory_item_id","location_id","sequence");--> statement-breakpoint
CREATE INDEX "inventory_transactions_location_business_date_idx" ON "inventory_transactions" USING btree ("location_id","business_date");--> statement-breakpoint
CREATE INDEX "inventory_transactions_reference_idx" ON "inventory_transactions" USING btree ("reference_type","reference_id");--> statement-breakpoint
CREATE INDEX "purchase_order_receipt_lines_order_line_idx" ON "purchase_order_receipt_lines" USING btree ("purchase_order_line_id");--> statement-breakpoint
CREATE INDEX "purchase_order_receipts_order_idx" ON "purchase_order_receipts" USING btree ("purchase_order_id");--> statement-breakpoint
CREATE INDEX "purchase_orders_location_status_idx" ON "purchase_orders" USING btree ("location_id","status");--> statement-breakpoint
CREATE INDEX "supplier_item_cost_history_item_recorded_idx" ON "supplier_item_cost_history" USING btree ("supplier_item_id","recorded_at");--> statement-breakpoint
CREATE INDEX "supplier_items_inventory_item_id_idx" ON "supplier_items" USING btree ("inventory_item_id");--> statement-breakpoint
CREATE INDEX "modifier_inventory_effects_menu_item_idx" ON "modifier_inventory_effects" USING btree ("menu_item_id");--> statement-breakpoint
CREATE INDEX "recipe_version_ingredients_item_idx" ON "recipe_version_ingredients" USING btree ("inventory_item_id");