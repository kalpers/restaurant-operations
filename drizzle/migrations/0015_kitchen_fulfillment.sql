CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" bigint GENERATED ALWAYS AS IDENTITY (sequence name "outbox_events_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"organization_id" uuid NOT NULL,
	"location_id" uuid,
	"event_type" text NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"recipient_user_id" uuid,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	CONSTRAINT "outbox_events_sequence_unique" UNIQUE("sequence"),
	CONSTRAINT "outbox_events_event_type_format" CHECK ("outbox_events"."event_type" ~ '^[a-z]+[.][a-z-]+$'),
	CONSTRAINT "outbox_events_attempts_non_negative" CHECK ("outbox_events"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "kitchen_remake_consumption" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"remake_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"inventory_item_id" uuid NOT NULL,
	"base_quantity" numeric(14, 4) NOT NULL,
	"base_unit_id" uuid NOT NULL,
	"source_consumption_id" uuid NOT NULL,
	"inventory_transaction_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kitchen_remake_consumption_remake_inventory_unique" UNIQUE("remake_id","inventory_item_id"),
	CONSTRAINT "kitchen_remake_consumption_transaction_unique" UNIQUE("inventory_transaction_id"),
	CONSTRAINT "kitchen_remake_consumption_quantity_positive" CHECK ("kitchen_remake_consumption"."base_quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "kitchen_remakes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"source_ticket_item_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"idempotency_record_id" uuid NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kitchen_remakes_item_attempt_unique" UNIQUE("order_item_id","attempt_number"),
	CONSTRAINT "kitchen_remakes_idempotency_record_unique" UNIQUE("idempotency_record_id"),
	CONSTRAINT "kitchen_remakes_attempt_valid" CHECK ("kitchen_remakes"."attempt_number" > 1),
	CONSTRAINT "kitchen_remakes_reason_valid" CHECK (length(trim("kitchen_remakes"."reason")) BETWEEN 1 AND 500)
);
--> statement-breakpoint
CREATE TABLE "kitchen_ticket_item_status_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_item_id" uuid NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"changed_by_user_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kitchen_ticket_item_status_history_status_valid" CHECK ("kitchen_ticket_item_status_history"."status" IN ('NEW', 'PREPARING', 'READY', 'COMPLETED', 'CANCELLED'))
);
--> statement-breakpoint
CREATE TABLE "kitchen_ticket_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"prep_station_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"status" text DEFAULT 'NEW' NOT NULL,
	"quantity" integer NOT NULL,
	"menu_item_code_snapshot" text NOT NULL,
	"menu_item_name_snapshot" text NOT NULL,
	"modifier_snapshots" jsonb NOT NULL,
	"kitchen_instructions_snapshot" text,
	"submitted_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"started_by_user_id" uuid,
	"ready_at" timestamp with time zone,
	"ready_by_user_id" uuid,
	"completed_at" timestamp with time zone,
	"completed_by_user_id" uuid,
	"cancelled_at" timestamp with time zone,
	"cancelled_by_user_id" uuid,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "kitchen_ticket_items_item_station_attempt_unique" UNIQUE("order_item_id","prep_station_id","attempt_number"),
	CONSTRAINT "kitchen_ticket_items_status_valid" CHECK ("kitchen_ticket_items"."status" IN ('NEW', 'PREPARING', 'READY', 'COMPLETED', 'CANCELLED')),
	CONSTRAINT "kitchen_ticket_items_quantity_positive" CHECK ("kitchen_ticket_items"."quantity" > 0),
	CONSTRAINT "kitchen_ticket_items_attempt_positive" CHECK ("kitchen_ticket_items"."attempt_number" > 0),
	CONSTRAINT "kitchen_ticket_items_lifecycle_fields" CHECK (("kitchen_ticket_items"."started_at" IS NULL) = ("kitchen_ticket_items"."started_by_user_id" IS NULL)
        AND ("kitchen_ticket_items"."ready_at" IS NULL) = ("kitchen_ticket_items"."ready_by_user_id" IS NULL)
        AND ("kitchen_ticket_items"."completed_at" IS NULL) = ("kitchen_ticket_items"."completed_by_user_id" IS NULL)
        AND ("kitchen_ticket_items"."cancelled_at" IS NULL) = ("kitchen_ticket_items"."cancelled_by_user_id" IS NULL)
        AND ("kitchen_ticket_items"."status" = 'CANCELLED') = ("kitchen_ticket_items"."cancelled_at" IS NOT NULL)
        AND ("kitchen_ticket_items"."status" = 'COMPLETED') = ("kitchen_ticket_items"."completed_at" IS NOT NULL)
        AND ("kitchen_ticket_items"."ready_at" IS NULL OR "kitchen_ticket_items"."started_at" IS NOT NULL)
        AND ("kitchen_ticket_items"."completed_at" IS NULL OR "kitchen_ticket_items"."ready_at" IS NOT NULL)
        AND ("kitchen_ticket_items"."status" <> 'NEW' OR "kitchen_ticket_items"."started_at" IS NULL)
        AND ("kitchen_ticket_items"."status" <> 'PREPARING' OR ("kitchen_ticket_items"."started_at" IS NOT NULL AND "kitchen_ticket_items"."ready_at" IS NULL))
        AND ("kitchen_ticket_items"."status" <> 'READY' OR "kitchen_ticket_items"."ready_at" IS NOT NULL)
        AND ("kitchen_ticket_items"."status" <> 'CANCELLED' OR length(trim(coalesce("kitchen_ticket_items"."cancel_reason", ''))) > 0))
);
--> statement-breakpoint
CREATE TABLE "kitchen_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"prep_station_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"send_batch_id" uuid NOT NULL,
	"remake_id" uuid,
	"attempt_number" integer NOT NULL,
	"business_date" date NOT NULL,
	"submitted_at" timestamp with time zone NOT NULL,
	"station_code_snapshot" text NOT NULL,
	"station_name_snapshot" text NOT NULL,
	"station_type_snapshot" text NOT NULL,
	"order_number_snapshot" integer NOT NULL,
	"order_type_snapshot" text NOT NULL,
	"batch_number_snapshot" integer NOT NULL,
	"table_label_snapshot" text,
	"pickup_label_snapshot" text,
	"server_name_snapshot" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kitchen_tickets_remake_station_unique" UNIQUE("remake_id","prep_station_id"),
	CONSTRAINT "kitchen_tickets_attempt_valid" CHECK ("kitchen_tickets"."attempt_number" > 0 AND ("kitchen_tickets"."remake_id" IS NULL) = ("kitchen_tickets"."attempt_number" = 1)),
	CONSTRAINT "kitchen_tickets_station_type_valid" CHECK ("kitchen_tickets"."station_type_snapshot" IN ('KITCHEN', 'BAR')),
	CONSTRAINT "kitchen_tickets_order_type_valid" CHECK ("kitchen_tickets"."order_type_snapshot" IN ('DINE_IN', 'BAR', 'TAKEOUT'))
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"recipient_user_id" uuid NOT NULL,
	"notification_type" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"order_id" uuid,
	"kitchen_ticket_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	CONSTRAINT "notifications_ticket_type_unique" UNIQUE("kitchen_ticket_id","notification_type"),
	CONSTRAINT "notifications_type_valid" CHECK ("notifications"."notification_type" IN ('FOOD_READY', 'BAR_ORDER_READY')),
	CONSTRAINT "notifications_title_not_blank" CHECK (length(trim("notifications"."title")) > 0)
);
--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_recipient_user_id_users_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_remake_consumption" ADD CONSTRAINT "kitchen_remake_consumption_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_remake_consumption" ADD CONSTRAINT "kitchen_remake_consumption_remake_id_kitchen_remakes_id_fk" FOREIGN KEY ("remake_id") REFERENCES "public"."kitchen_remakes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_remake_consumption" ADD CONSTRAINT "kitchen_remake_consumption_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_remake_consumption" ADD CONSTRAINT "kitchen_remake_consumption_base_unit_id_units_of_measure_id_fk" FOREIGN KEY ("base_unit_id") REFERENCES "public"."units_of_measure"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_remake_consumption" ADD CONSTRAINT "kitchen_remake_consumption_inventory_item_fk" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."inventory_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_remake_consumption" ADD CONSTRAINT "kitchen_remake_consumption_source_fk" FOREIGN KEY ("source_consumption_id") REFERENCES "public"."order_item_inventory_consumption"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_remake_consumption" ADD CONSTRAINT "kitchen_remake_consumption_transaction_fk" FOREIGN KEY ("inventory_transaction_id") REFERENCES "public"."inventory_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_remakes" ADD CONSTRAINT "kitchen_remakes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_remakes" ADD CONSTRAINT "kitchen_remakes_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_remakes" ADD CONSTRAINT "kitchen_remakes_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_remakes" ADD CONSTRAINT "kitchen_remakes_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_remakes" ADD CONSTRAINT "kitchen_remakes_idempotency_record_id_idempotency_records_id_fk" FOREIGN KEY ("idempotency_record_id") REFERENCES "public"."idempotency_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_remakes" ADD CONSTRAINT "kitchen_remakes_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_remakes" ADD CONSTRAINT "kitchen_remakes_source_item_fk" FOREIGN KEY ("source_ticket_item_id") REFERENCES "public"."kitchen_ticket_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_ticket_item_status_history" ADD CONSTRAINT "kitchen_item_history_item_fk" FOREIGN KEY ("ticket_item_id") REFERENCES "public"."kitchen_ticket_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_ticket_item_status_history" ADD CONSTRAINT "kitchen_item_history_user_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_ticket_items" ADD CONSTRAINT "kitchen_ticket_items_ticket_id_kitchen_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."kitchen_tickets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_ticket_items" ADD CONSTRAINT "kitchen_ticket_items_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_ticket_items" ADD CONSTRAINT "kitchen_ticket_items_started_by_user_id_users_id_fk" FOREIGN KEY ("started_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_ticket_items" ADD CONSTRAINT "kitchen_ticket_items_ready_by_user_id_users_id_fk" FOREIGN KEY ("ready_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_ticket_items" ADD CONSTRAINT "kitchen_ticket_items_completed_by_user_id_users_id_fk" FOREIGN KEY ("completed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_ticket_items" ADD CONSTRAINT "kitchen_ticket_items_cancelled_by_user_id_users_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_ticket_items" ADD CONSTRAINT "kitchen_ticket_items_station_location_fk" FOREIGN KEY ("prep_station_id","location_id") REFERENCES "public"."prep_stations"("id","location_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_ticket_items" ADD CONSTRAINT "kitchen_ticket_items_order_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_tickets" ADD CONSTRAINT "kitchen_tickets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_tickets" ADD CONSTRAINT "kitchen_tickets_location_org_fk" FOREIGN KEY ("location_id","organization_id") REFERENCES "public"."locations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_tickets" ADD CONSTRAINT "kitchen_tickets_station_location_fk" FOREIGN KEY ("prep_station_id","location_id") REFERENCES "public"."prep_stations"("id","location_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_tickets" ADD CONSTRAINT "kitchen_tickets_order_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_tickets" ADD CONSTRAINT "kitchen_tickets_batch_order_fk" FOREIGN KEY ("send_batch_id","order_id") REFERENCES "public"."order_send_batches"("id","order_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_tickets" ADD CONSTRAINT "kitchen_tickets_remake_fk" FOREIGN KEY ("remake_id") REFERENCES "public"."kitchen_remakes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_user_id_users_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_kitchen_ticket_id_kitchen_tickets_id_fk" FOREIGN KEY ("kitchen_ticket_id") REFERENCES "public"."kitchen_tickets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_location_org_fk" FOREIGN KEY ("location_id","organization_id") REFERENCES "public"."locations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outbox_events_unpublished_idx" ON "outbox_events" USING btree ("sequence") WHERE "outbox_events"."published_at" IS NULL;--> statement-breakpoint
CREATE INDEX "kitchen_remake_consumption_order_item_idx" ON "kitchen_remake_consumption" USING btree ("order_item_id");--> statement-breakpoint
CREATE INDEX "kitchen_remakes_order_item_idx" ON "kitchen_remakes" USING btree ("order_item_id");--> statement-breakpoint
CREATE INDEX "kitchen_ticket_item_status_history_item_idx" ON "kitchen_ticket_item_status_history" USING btree ("ticket_item_id","occurred_at");--> statement-breakpoint
CREATE INDEX "kitchen_ticket_items_queue_idx" ON "kitchen_ticket_items" USING btree ("location_id","status","submitted_at","id");--> statement-breakpoint
CREATE INDEX "kitchen_ticket_items_ticket_idx" ON "kitchen_ticket_items" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "kitchen_ticket_items_order_item_idx" ON "kitchen_ticket_items" USING btree ("order_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "kitchen_tickets_batch_station_unique" ON "kitchen_tickets" USING btree ("send_batch_id","prep_station_id") WHERE "kitchen_tickets"."remake_id" IS NULL;--> statement-breakpoint
CREATE INDEX "kitchen_tickets_location_submitted_idx" ON "kitchen_tickets" USING btree ("location_id","submitted_at","id");--> statement-breakpoint
CREATE INDEX "kitchen_tickets_order_idx" ON "kitchen_tickets" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "notifications_recipient_idx" ON "notifications" USING btree ("recipient_user_id","read_at","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_transactions_remake_consume_unique" ON "inventory_transactions" USING btree ("reference_id","inventory_item_id") WHERE "inventory_transactions"."transaction_type" = 'CONSUME' AND "inventory_transactions"."reference_type" = 'KITCHEN_REMAKE';