CREATE TABLE "cash_drawer_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"movement_type" text NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"reason" text NOT NULL,
	"recorded_by_user_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"idempotency_record_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cash_drawer_movements_type_valid" CHECK ("cash_drawer_movements"."movement_type" IN ('PAID_IN', 'PAID_OUT')),
	CONSTRAINT "cash_drawer_movements_amount_positive" CHECK ("cash_drawer_movements"."amount" > 0),
	CONSTRAINT "cash_drawer_movements_reason" CHECK (length(trim("cash_drawer_movements"."reason")) > 0 AND "cash_drawer_movements"."reason" !~ '[0-9]{13,}')
);
--> statement-breakpoint
CREATE TABLE "cash_drawer_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"drawer_id" uuid NOT NULL,
	"session_number" integer NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"business_date" date NOT NULL,
	"opening_float" numeric(12, 2) NOT NULL,
	"opened_by_user_id" uuid NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"closed_by_user_id" uuid,
	"closed_at" timestamp with time zone,
	"counted_amount" numeric(12, 2),
	"expected_amount" numeric(12, 2),
	"variance" numeric(12, 2),
	"close_note" text,
	"open_idempotency_record_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "cash_drawer_sessions_drawer_number_unique" UNIQUE("drawer_id","session_number"),
	CONSTRAINT "cash_drawer_sessions_status_valid" CHECK ("cash_drawer_sessions"."status" IN ('OPEN', 'CLOSED')),
	CONSTRAINT "cash_drawer_sessions_float_non_negative" CHECK ("cash_drawer_sessions"."opening_float" >= 0),
	CONSTRAINT "cash_drawer_sessions_closed_fields" CHECK (("cash_drawer_sessions"."status" = 'CLOSED') = ("cash_drawer_sessions"."closed_at" IS NOT NULL)
        AND ("cash_drawer_sessions"."closed_at" IS NULL) = ("cash_drawer_sessions"."closed_by_user_id" IS NULL)
        AND ("cash_drawer_sessions"."closed_at" IS NULL) = ("cash_drawer_sessions"."counted_amount" IS NULL)
        AND ("cash_drawer_sessions"."closed_at" IS NULL) = ("cash_drawer_sessions"."expected_amount" IS NULL)
        AND ("cash_drawer_sessions"."expected_amount" IS NULL) = ("cash_drawer_sessions"."variance" IS NULL)
        AND ("cash_drawer_sessions"."counted_amount" IS NULL OR "cash_drawer_sessions"."counted_amount" >= 0)
        AND ("cash_drawer_sessions"."variance" IS NULL OR "cash_drawer_sessions"."variance" = "cash_drawer_sessions"."counted_amount" - "cash_drawer_sessions"."expected_amount"))
);
--> statement-breakpoint
CREATE TABLE "cash_drawers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "cash_drawers_location_code_unique" UNIQUE("location_id","code"),
	CONSTRAINT "cash_drawers_id_location_unique" UNIQUE("id","location_id"),
	CONSTRAINT "cash_drawers_code_not_blank" CHECK (length(trim("cash_drawers"."code")) > 0),
	CONSTRAINT "cash_drawers_name_not_blank" CHECK (length(trim("cash_drawers"."name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "order_refund_items" (
	"refund_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_refund_items_pk" PRIMARY KEY("refund_id","order_item_id")
);
--> statement-breakpoint
CREATE TABLE "order_refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"settlement_id" uuid NOT NULL,
	"refund_number" integer NOT NULL,
	"status" text DEFAULT 'RECORDED' NOT NULL,
	"tender_type" text NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"tax_amount" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"reason" text NOT NULL,
	"other_description" text,
	"external_reference" text,
	"cash_drawer_session_id" uuid,
	"business_date" date NOT NULL,
	"recorded_by_user_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"voided_by_user_id" uuid,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"idempotency_record_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "order_refunds_order_number_unique" UNIQUE("order_id","refund_number"),
	CONSTRAINT "order_refunds_type_valid" CHECK ("order_refunds"."tender_type" IN ('CASH', 'EXTERNAL_CARD', 'GIFT_CARD', 'HOUSE_ACCOUNT', 'OTHER')),
	CONSTRAINT "order_refunds_status_valid" CHECK ("order_refunds"."status" IN ('RECORDED', 'VOIDED')),
	CONSTRAINT "order_refunds_amounts_valid" CHECK ("order_refunds"."amount" > 0 AND "order_refunds"."tax_amount" >= 0 AND "order_refunds"."tax_amount" <= "order_refunds"."amount"),
	CONSTRAINT "order_refunds_reason" CHECK (length(trim("order_refunds"."reason")) > 0),
	CONSTRAINT "order_refunds_other_description" CHECK (("order_refunds"."tender_type" <> 'OTHER' OR length(trim(coalesce("order_refunds"."other_description", ''))) > 0)
        AND ("order_refunds"."tender_type" = 'OTHER' OR "order_refunds"."other_description" IS NULL)),
	CONSTRAINT "order_refunds_cash_fields" CHECK (("order_refunds"."tender_type" = 'CASH' OR "order_refunds"."cash_drawer_session_id" IS NULL)
        AND ("order_refunds"."tender_type" <> 'CASH' OR "order_refunds"."external_reference" IS NULL)),
	CONSTRAINT "order_refunds_no_pan" CHECK (("order_refunds"."external_reference" IS NULL OR "order_refunds"."external_reference" !~ '[0-9]{13,}') AND ("order_refunds"."reason" IS NULL OR "order_refunds"."reason" !~ '[0-9]{13,}')
        AND ("order_refunds"."other_description" IS NULL OR "order_refunds"."other_description" !~ '[0-9]{13,}') AND ("order_refunds"."void_reason" IS NULL OR "order_refunds"."void_reason" !~ '[0-9]{13,}')),
	CONSTRAINT "order_refunds_void_fields" CHECK (("order_refunds"."status" = 'VOIDED') = ("order_refunds"."voided_at" IS NOT NULL)
        AND ("order_refunds"."voided_at" IS NULL) = ("order_refunds"."voided_by_user_id" IS NULL)
        AND ("order_refunds"."voided_at" IS NULL) = ("order_refunds"."void_reason" IS NULL)
        AND ("order_refunds"."void_reason" IS NULL OR length(trim("order_refunds"."void_reason")) > 0))
);
--> statement-breakpoint
ALTER TABLE "location_settings" ADD COLUMN "cash_drawer_required" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "settlement_tenders" ADD COLUMN "cash_drawer_session_id" uuid;--> statement-breakpoint
ALTER TABLE "cash_drawer_movements" ADD CONSTRAINT "cash_drawer_movements_session_id_cash_drawer_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."cash_drawer_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_drawer_movements" ADD CONSTRAINT "cash_drawer_movements_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_drawer_movements" ADD CONSTRAINT "cash_drawer_movements_idempotency_record_id_idempotency_records_id_fk" FOREIGN KEY ("idempotency_record_id") REFERENCES "public"."idempotency_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_drawer_sessions" ADD CONSTRAINT "cash_drawer_sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_drawer_sessions" ADD CONSTRAINT "cash_drawer_sessions_opened_by_user_id_users_id_fk" FOREIGN KEY ("opened_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_drawer_sessions" ADD CONSTRAINT "cash_drawer_sessions_closed_by_user_id_users_id_fk" FOREIGN KEY ("closed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_drawer_sessions" ADD CONSTRAINT "cash_drawer_sessions_drawer_location_fk" FOREIGN KEY ("drawer_id","location_id") REFERENCES "public"."cash_drawers"("id","location_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_drawer_sessions" ADD CONSTRAINT "cash_drawer_sessions_open_idempotency_fk" FOREIGN KEY ("open_idempotency_record_id") REFERENCES "public"."idempotency_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_drawers" ADD CONSTRAINT "cash_drawers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_drawers" ADD CONSTRAINT "cash_drawers_location_org_fk" FOREIGN KEY ("location_id","organization_id") REFERENCES "public"."locations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_refund_items" ADD CONSTRAINT "order_refund_items_refund_id_order_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."order_refunds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_refund_items" ADD CONSTRAINT "order_refund_items_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_refunds" ADD CONSTRAINT "order_refunds_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_refunds" ADD CONSTRAINT "order_refunds_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_refunds" ADD CONSTRAINT "order_refunds_settlement_id_order_settlements_id_fk" FOREIGN KEY ("settlement_id") REFERENCES "public"."order_settlements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_refunds" ADD CONSTRAINT "order_refunds_cash_drawer_session_id_cash_drawer_sessions_id_fk" FOREIGN KEY ("cash_drawer_session_id") REFERENCES "public"."cash_drawer_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_refunds" ADD CONSTRAINT "order_refunds_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_refunds" ADD CONSTRAINT "order_refunds_voided_by_user_id_users_id_fk" FOREIGN KEY ("voided_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_refunds" ADD CONSTRAINT "order_refunds_idempotency_record_id_idempotency_records_id_fk" FOREIGN KEY ("idempotency_record_id") REFERENCES "public"."idempotency_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_refunds" ADD CONSTRAINT "order_refunds_location_org_fk" FOREIGN KEY ("location_id","organization_id") REFERENCES "public"."locations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cash_drawer_movements_idempotency_unique" ON "cash_drawer_movements" USING btree ("idempotency_record_id");--> statement-breakpoint
CREATE INDEX "cash_drawer_movements_session_idx" ON "cash_drawer_movements" USING btree ("session_id","recorded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "cash_drawer_sessions_one_open_per_drawer" ON "cash_drawer_sessions" USING btree ("drawer_id") WHERE "cash_drawer_sessions"."status" = 'OPEN';--> statement-breakpoint
CREATE INDEX "cash_drawer_sessions_location_date_idx" ON "cash_drawer_sessions" USING btree ("location_id","business_date");--> statement-breakpoint
CREATE UNIQUE INDEX "order_refunds_idempotency_unique" ON "order_refunds" USING btree ("idempotency_record_id");--> statement-breakpoint
CREATE INDEX "order_refunds_location_date_idx" ON "order_refunds" USING btree ("location_id","business_date");--> statement-breakpoint
CREATE INDEX "order_refunds_order_idx" ON "order_refunds" USING btree ("order_id");--> statement-breakpoint
ALTER TABLE "settlement_tenders" ADD CONSTRAINT "settlement_tenders_cash_drawer_session_id_cash_drawer_sessions_id_fk" FOREIGN KEY ("cash_drawer_session_id") REFERENCES "public"."cash_drawer_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "settlement_tenders_drawer_session_idx" ON "settlement_tenders" USING btree ("cash_drawer_session_id");--> statement-breakpoint
ALTER TABLE "settlement_tenders" ADD CONSTRAINT "settlement_tenders_drawer_cash_only" CHECK ("settlement_tenders"."cash_drawer_session_id" IS NULL OR "settlement_tenders"."tender_type" = 'CASH');