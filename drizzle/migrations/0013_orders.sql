CREATE TABLE "idempotency_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"request_fingerprint" text NOT NULL,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_records_org_scope_key_unique" UNIQUE("organization_id","scope","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "discount_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"scope" text NOT NULL,
	"discount_type" text NOT NULL,
	"value" numeric(12, 2) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "discount_definitions_organization_id_code_unique" UNIQUE("organization_id","code"),
	CONSTRAINT "discount_definitions_scope_valid" CHECK ("discount_definitions"."scope" IN ('ITEM', 'ORDER')),
	CONSTRAINT "discount_definitions_type_valid" CHECK ("discount_definitions"."discount_type" IN ('FIXED_AMOUNT', 'PERCENTAGE')),
	CONSTRAINT "discount_definitions_value_valid" CHECK ("discount_definitions"."value" > 0 AND ("discount_definitions"."discount_type" <> 'PERCENTAGE' OR "discount_definitions"."value" <= 100)),
	CONSTRAINT "discount_definitions_code_not_blank" CHECK (length(trim("discount_definitions"."code")) > 0),
	CONSTRAINT "discount_definitions_name_not_blank" CHECK (length(trim("discount_definitions"."name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "order_discounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"discount_definition_id" uuid NOT NULL,
	"sequence" bigint GENERATED ALWAYS AS IDENTITY (sequence name "order_discounts_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"code_snapshot" text NOT NULL,
	"name_snapshot" text NOT NULL,
	"discount_type_snapshot" text NOT NULL,
	"value_snapshot" numeric(12, 2) NOT NULL,
	"is_comp" boolean NOT NULL,
	"reason" text NOT NULL,
	"applied_amount" numeric(12, 2) NOT NULL,
	"status" text DEFAULT 'APPLIED' NOT NULL,
	"applied_by_user_id" uuid NOT NULL,
	"applied_at" timestamp with time zone NOT NULL,
	"removed_by_user_id" uuid,
	"removed_at" timestamp with time zone,
	"remove_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"order_id" uuid NOT NULL,
	CONSTRAINT "order_discounts_sequence_unique" UNIQUE("sequence"),
	CONSTRAINT "order_discounts_status_valid" CHECK ("order_discounts"."status" IN ('APPLIED', 'REMOVED')),
	CONSTRAINT "order_discounts_amount_non_negative" CHECK ("order_discounts"."applied_amount" >= 0),
	CONSTRAINT "order_discounts_reason_not_blank" CHECK (length(trim("order_discounts"."reason")) > 0),
	CONSTRAINT "order_discounts_removed_fields" CHECK (("order_discounts"."status" = 'REMOVED') = ("order_discounts"."removed_at" IS NOT NULL)
        AND ("order_discounts"."removed_at" IS NULL) = ("order_discounts"."removed_by_user_id" IS NULL)),
	CONSTRAINT "order_discounts_type_valid" CHECK ("order_discounts"."discount_type_snapshot" IN ('FIXED_AMOUNT', 'PERCENTAGE'))
);
--> statement-breakpoint
CREATE TABLE "order_item_discounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"discount_definition_id" uuid NOT NULL,
	"sequence" bigint GENERATED ALWAYS AS IDENTITY (sequence name "order_item_discounts_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"code_snapshot" text NOT NULL,
	"name_snapshot" text NOT NULL,
	"discount_type_snapshot" text NOT NULL,
	"value_snapshot" numeric(12, 2) NOT NULL,
	"is_comp" boolean NOT NULL,
	"reason" text NOT NULL,
	"applied_amount" numeric(12, 2) NOT NULL,
	"status" text DEFAULT 'APPLIED' NOT NULL,
	"applied_by_user_id" uuid NOT NULL,
	"applied_at" timestamp with time zone NOT NULL,
	"removed_by_user_id" uuid,
	"removed_at" timestamp with time zone,
	"remove_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"order_item_id" uuid NOT NULL,
	CONSTRAINT "order_item_discounts_sequence_unique" UNIQUE("sequence"),
	CONSTRAINT "order_item_discounts_status_valid" CHECK ("order_item_discounts"."status" IN ('APPLIED', 'REMOVED', 'VOIDED')),
	CONSTRAINT "order_item_discounts_amount_non_negative" CHECK ("order_item_discounts"."applied_amount" >= 0),
	CONSTRAINT "order_item_discounts_reason_not_blank" CHECK (length(trim("order_item_discounts"."reason")) > 0),
	CONSTRAINT "order_item_discounts_removed_fields" CHECK (("order_item_discounts"."status" = 'REMOVED') = ("order_item_discounts"."removed_at" IS NOT NULL)
        AND ("order_item_discounts"."removed_at" IS NULL) = ("order_item_discounts"."removed_by_user_id" IS NULL)),
	CONSTRAINT "order_item_discounts_type_valid" CHECK ("order_item_discounts"."discount_type_snapshot" IN ('FIXED_AMOUNT', 'PERCENTAGE'))
);
--> statement-breakpoint
CREATE TABLE "order_item_inventory_consumption" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"send_batch_id" uuid NOT NULL,
	"inventory_item_id" uuid NOT NULL,
	"base_quantity" numeric(14, 4) NOT NULL,
	"base_unit_id" uuid NOT NULL,
	"recipe_version_id" uuid,
	"source_snapshot" jsonb NOT NULL,
	"inventory_transaction_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_item_inventory_consumption_item_inventory_unique" UNIQUE("order_item_id","inventory_item_id"),
	CONSTRAINT "order_item_inventory_consumption_transaction_unique" UNIQUE("inventory_transaction_id"),
	CONSTRAINT "order_item_inventory_consumption_positive" CHECK ("order_item_inventory_consumption"."base_quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "order_item_modifiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_item_id" uuid NOT NULL,
	"modifier_group_id" uuid NOT NULL,
	"modifier_id" uuid NOT NULL,
	"modifier_group_name_snapshot" text NOT NULL,
	"modifier_code_snapshot" text NOT NULL,
	"modifier_name_snapshot" text NOT NULL,
	"price_adjustment_snapshot" numeric(12, 2) NOT NULL,
	"preparation_effect_type_snapshot" text NOT NULL,
	"preparation_instruction_snapshot" text,
	"sort_order" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_item_modifiers_item_group_modifier_unique" UNIQUE("order_item_id","modifier_group_id","modifier_id")
);
--> statement-breakpoint
CREATE TABLE "order_item_status_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_item_id" uuid NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"changed_by_user_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_item_status_history_status_valid" CHECK ("order_item_status_history"."status" IN ('SUBMITTED', 'VOIDED'))
);
--> statement-breakpoint
CREATE TABLE "order_item_voids" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_item_id" uuid NOT NULL,
	"disposition" text NOT NULL,
	"reason" text NOT NULL,
	"voided_by_user_id" uuid NOT NULL,
	"voided_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_item_voids_item_unique" UNIQUE("order_item_id"),
	CONSTRAINT "order_item_voids_disposition_valid" CHECK ("order_item_voids"."disposition" IN ('UNPREPARED', 'PREPARED_OR_DISCARDED')),
	CONSTRAINT "order_item_voids_reason_not_blank" CHECK (length(trim("order_item_voids"."reason")) > 0)
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"menu_item_id" uuid NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"quantity" integer NOT NULL,
	"menu_item_code_snapshot" text NOT NULL,
	"menu_item_name_snapshot" text NOT NULL,
	"base_price_snapshot" numeric(12, 2) NOT NULL,
	"modifier_total_snapshot" numeric(12, 2) NOT NULL,
	"unit_price_snapshot" numeric(12, 2) NOT NULL,
	"line_total_snapshot" numeric(12, 2) NOT NULL,
	"special_instructions" text,
	"kitchen_instructions_snapshot" text,
	"prep_station_ids_snapshot" uuid[],
	"recipe_id" uuid,
	"recipe_version_id" uuid,
	"send_batch_id" uuid,
	"added_by_user_id" uuid NOT NULL,
	"submitted_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"voided_by_user_id" uuid,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "order_items_status_valid" CHECK ("order_items"."status" IN ('DRAFT', 'SUBMITTED', 'VOIDED')),
	CONSTRAINT "order_items_quantity_positive" CHECK ("order_items"."quantity" > 0),
	CONSTRAINT "order_items_amounts_valid" CHECK ("order_items"."base_price_snapshot" >= 0 AND "order_items"."unit_price_snapshot" >= 0
        AND "order_items"."unit_price_snapshot" = "order_items"."base_price_snapshot" + "order_items"."modifier_total_snapshot"
        AND "order_items"."line_total_snapshot" = "order_items"."unit_price_snapshot" * "order_items"."quantity"),
	CONSTRAINT "order_items_send_fields" CHECK (("order_items"."send_batch_id" IS NULL) = ("order_items"."submitted_at" IS NULL)
        AND ("order_items"."status" <> 'SUBMITTED' OR "order_items"."send_batch_id" IS NOT NULL)
        AND ("order_items"."status" <> 'DRAFT' OR "order_items"."send_batch_id" IS NULL)
        AND ("order_items"."recipe_version_id" IS NULL OR "order_items"."recipe_id" IS NOT NULL)),
	CONSTRAINT "order_items_void_fields" CHECK (("order_items"."status" = 'VOIDED') = ("order_items"."voided_at" IS NOT NULL)
        AND ("order_items"."voided_at" IS NULL) = ("order_items"."voided_by_user_id" IS NULL)
        AND ("order_items"."voided_at" IS NULL OR length(trim(coalesce("order_items"."void_reason", ''))) > 0)),
	CONSTRAINT "order_items_special_instructions_length" CHECK ("order_items"."special_instructions" IS NULL OR length("order_items"."special_instructions") <= 500)
);
--> statement-breakpoint
CREATE TABLE "order_number_counters" (
	"location_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"last_number" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "order_number_counters_pk" PRIMARY KEY("location_id","business_date"),
	CONSTRAINT "order_number_counters_non_negative" CHECK ("order_number_counters"."last_number" >= 0)
);
--> statement-breakpoint
CREATE TABLE "order_send_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"batch_number" integer NOT NULL,
	"idempotency_record_id" uuid NOT NULL,
	"sent_by_user_id" uuid NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"business_date" date NOT NULL,
	"item_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_send_batches_order_number_unique" UNIQUE("order_id","batch_number"),
	CONSTRAINT "order_send_batches_id_order_id_unique" UNIQUE("id","order_id"),
	CONSTRAINT "order_send_batches_idempotency_record_unique" UNIQUE("idempotency_record_id"),
	CONSTRAINT "order_send_batches_number_positive" CHECK ("order_send_batches"."batch_number" > 0),
	CONSTRAINT "order_send_batches_item_count_positive" CHECK ("order_send_batches"."item_count" > 0)
);
--> statement-breakpoint
CREATE TABLE "order_status_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"changed_by_user_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_status_history_status_valid" CHECK ("order_status_history"."status" IN ('OPEN', 'CLOSED', 'VOIDED'))
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"order_type" text NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"order_number" integer NOT NULL,
	"business_date" date NOT NULL,
	"table_session_id" uuid,
	"guest_party_id" uuid,
	"customer_name" text,
	"opened_by_user_id" uuid NOT NULL,
	"opened_by_employee_id" uuid,
	"assigned_server_employee_id" uuid,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"voided_by_user_id" uuid,
	"void_reason" text,
	"item_subtotal" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"discount_total" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"subtotal" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "orders_location_business_date_number_unique" UNIQUE("location_id","business_date","order_number"),
	CONSTRAINT "orders_id_organization_id_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "orders_type_valid" CHECK ("orders"."order_type" IN ('DINE_IN', 'BAR', 'TAKEOUT')),
	CONSTRAINT "orders_status_valid" CHECK ("orders"."status" IN ('OPEN', 'CLOSED', 'VOIDED')),
	CONSTRAINT "orders_session_matches_type" CHECK (("orders"."order_type" = 'TAKEOUT') = ("orders"."table_session_id" IS NULL)),
	CONSTRAINT "orders_takeout_has_no_party" CHECK ("orders"."order_type" <> 'TAKEOUT' OR "orders"."guest_party_id" IS NULL),
	CONSTRAINT "orders_customer_name_takeout_only" CHECK ("orders"."customer_name" IS NULL OR ("orders"."order_type" = 'TAKEOUT' AND length(trim("orders"."customer_name")) BETWEEN 1 AND 60)),
	CONSTRAINT "orders_number_positive" CHECK ("orders"."order_number" > 0),
	CONSTRAINT "orders_void_fields" CHECK (("orders"."status" = 'VOIDED') = ("orders"."voided_at" IS NOT NULL)
        AND ("orders"."voided_at" IS NULL) = ("orders"."voided_by_user_id" IS NULL)
        AND ("orders"."voided_at" IS NULL OR length(trim(coalesce("orders"."void_reason", ''))) > 0)),
	CONSTRAINT "orders_closed_fields" CHECK (("orders"."status" = 'CLOSED') = ("orders"."closed_at" IS NOT NULL)),
	CONSTRAINT "orders_totals_valid" CHECK ("orders"."item_subtotal" >= 0 AND "orders"."discount_total" >= 0
        AND "orders"."discount_total" <= "orders"."item_subtotal"
        AND "orders"."subtotal" = "orders"."item_subtotal" - "orders"."discount_total")
);
--> statement-breakpoint
ALTER TABLE "inventory_transactions" DROP CONSTRAINT "inventory_transactions_type_valid";--> statement-breakpoint
ALTER TABLE "inventory_transactions" DROP CONSTRAINT "inventory_transactions_direction_matches_type";--> statement-breakpoint
ALTER TABLE "inventory_transactions" ADD COLUMN "reverses_transaction_id" uuid;--> statement-breakpoint
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_definitions" ADD CONSTRAINT "discount_definitions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_discounts" ADD CONSTRAINT "order_discounts_applied_by_user_id_users_id_fk" FOREIGN KEY ("applied_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_discounts" ADD CONSTRAINT "order_discounts_removed_by_user_id_users_id_fk" FOREIGN KEY ("removed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_discounts" ADD CONSTRAINT "order_discounts_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_discounts" ADD CONSTRAINT "order_discounts_definition_fk" FOREIGN KEY ("discount_definition_id") REFERENCES "public"."discount_definitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_discounts" ADD CONSTRAINT "order_item_discounts_applied_by_user_id_users_id_fk" FOREIGN KEY ("applied_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_discounts" ADD CONSTRAINT "order_item_discounts_removed_by_user_id_users_id_fk" FOREIGN KEY ("removed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_discounts" ADD CONSTRAINT "order_item_discounts_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_discounts" ADD CONSTRAINT "order_item_discounts_definition_fk" FOREIGN KEY ("discount_definition_id") REFERENCES "public"."discount_definitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_inventory_consumption" ADD CONSTRAINT "order_item_consumption_org_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_inventory_consumption" ADD CONSTRAINT "order_item_consumption_item_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_inventory_consumption" ADD CONSTRAINT "order_item_consumption_batch_fk" FOREIGN KEY ("send_batch_id") REFERENCES "public"."order_send_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_inventory_consumption" ADD CONSTRAINT "order_item_consumption_inventory_item_fk" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."inventory_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_inventory_consumption" ADD CONSTRAINT "order_item_consumption_base_unit_fk" FOREIGN KEY ("base_unit_id") REFERENCES "public"."units_of_measure"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_inventory_consumption" ADD CONSTRAINT "order_item_consumption_recipe_version_fk" FOREIGN KEY ("recipe_version_id") REFERENCES "public"."recipe_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_inventory_consumption" ADD CONSTRAINT "order_item_consumption_transaction_fk" FOREIGN KEY ("inventory_transaction_id") REFERENCES "public"."inventory_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_modifiers" ADD CONSTRAINT "order_item_modifiers_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_modifiers" ADD CONSTRAINT "order_item_modifiers_modifier_group_id_modifier_groups_id_fk" FOREIGN KEY ("modifier_group_id") REFERENCES "public"."modifier_groups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_modifiers" ADD CONSTRAINT "order_item_modifiers_modifier_id_modifiers_id_fk" FOREIGN KEY ("modifier_id") REFERENCES "public"."modifiers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_status_history" ADD CONSTRAINT "order_item_status_history_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_status_history" ADD CONSTRAINT "order_item_status_history_changed_by_user_id_users_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_voids" ADD CONSTRAINT "order_item_voids_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_voids" ADD CONSTRAINT "order_item_voids_voided_by_user_id_users_id_fk" FOREIGN KEY ("voided_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_menu_item_id_menu_items_id_fk" FOREIGN KEY ("menu_item_id") REFERENCES "public"."menu_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_recipe_version_id_recipe_versions_id_fk" FOREIGN KEY ("recipe_version_id") REFERENCES "public"."recipe_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_added_by_user_id_users_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_voided_by_user_id_users_id_fk" FOREIGN KEY ("voided_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_send_batch_order_fk" FOREIGN KEY ("send_batch_id","order_id") REFERENCES "public"."order_send_batches"("id","order_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_number_counters" ADD CONSTRAINT "order_number_counters_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_send_batches" ADD CONSTRAINT "order_send_batches_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_send_batches" ADD CONSTRAINT "order_send_batches_sent_by_user_id_users_id_fk" FOREIGN KEY ("sent_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_send_batches" ADD CONSTRAINT "order_send_batches_idempotency_fk" FOREIGN KEY ("idempotency_record_id") REFERENCES "public"."idempotency_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_changed_by_user_id_users_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_opened_by_user_id_users_id_fk" FOREIGN KEY ("opened_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_opened_by_employee_id_employees_id_fk" FOREIGN KEY ("opened_by_employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_assigned_server_employee_id_employees_id_fk" FOREIGN KEY ("assigned_server_employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_voided_by_user_id_users_id_fk" FOREIGN KEY ("voided_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_location_org_fk" FOREIGN KEY ("location_id","organization_id") REFERENCES "public"."locations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_table_session_location_fk" FOREIGN KEY ("table_session_id","location_id") REFERENCES "public"."table_sessions"("id","location_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_guest_party_location_fk" FOREIGN KEY ("guest_party_id","location_id") REFERENCES "public"."guest_parties"("id","location_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_discounts_order_idx" ON "order_discounts" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_item_discounts_item_idx" ON "order_item_discounts" USING btree ("order_item_id");--> statement-breakpoint
CREATE INDEX "order_item_status_history_item_idx" ON "order_item_status_history" USING btree ("order_item_id","occurred_at");--> statement-breakpoint
CREATE INDEX "order_items_order_status_idx" ON "order_items" USING btree ("order_id","status");--> statement-breakpoint
CREATE INDEX "order_items_send_batch_idx" ON "order_items" USING btree ("send_batch_id");--> statement-breakpoint
CREATE INDEX "order_status_history_order_idx" ON "order_status_history" USING btree ("order_id","occurred_at");--> statement-breakpoint
CREATE INDEX "orders_table_session_status_idx" ON "orders" USING btree ("table_session_id","status");--> statement-breakpoint
CREATE INDEX "orders_location_status_idx" ON "orders" USING btree ("location_id","status");--> statement-breakpoint
CREATE INDEX "orders_location_business_date_idx" ON "orders" USING btree ("location_id","business_date");--> statement-breakpoint
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_reverses_fk" FOREIGN KEY ("reverses_transaction_id") REFERENCES "public"."inventory_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_transactions_reverses_unique" ON "inventory_transactions" USING btree ("reverses_transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_transactions_order_item_consume_unique" ON "inventory_transactions" USING btree ("reference_id","inventory_item_id") WHERE "inventory_transactions"."transaction_type" = 'CONSUME' AND "inventory_transactions"."reference_type" = 'ORDER_ITEM';--> statement-breakpoint
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_reversal_link" CHECK (("inventory_transactions"."transaction_type" = 'SALE_REVERSAL') = ("inventory_transactions"."reverses_transaction_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_type_valid" CHECK ("inventory_transactions"."transaction_type" IN ('RECEIVE', 'CONSUME', 'WASTE', 'ADJUST_INCREASE', 'ADJUST_DECREASE', 'COUNT_INCREASE', 'COUNT_DECREASE', 'TRANSFER_OUT', 'TRANSFER_IN', 'SALE_REVERSAL'));--> statement-breakpoint
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_direction_matches_type" CHECK (("inventory_transactions"."transaction_type" IN ('RECEIVE', 'ADJUST_INCREASE', 'COUNT_INCREASE', 'TRANSFER_IN', 'SALE_REVERSAL') AND "inventory_transactions"."base_quantity_delta" > 0 AND "inventory_transactions"."quantity" > 0)
        OR ("inventory_transactions"."transaction_type" IN ('CONSUME', 'WASTE', 'ADJUST_DECREASE', 'COUNT_DECREASE', 'TRANSFER_OUT') AND "inventory_transactions"."base_quantity_delta" < 0 AND "inventory_transactions"."quantity" < 0));