CREATE TABLE "settlement_status_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"settlement_id" uuid NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"changed_by_user_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settlement_status_history_status_valid" CHECK ("settlement_status_history"."status" IN ('OPEN', 'COMPLETED', 'CANCELLED'))
);
--> statement-breakpoint
CREATE TABLE "settlement_tenders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"settlement_id" uuid NOT NULL,
	"tender_type" text NOT NULL,
	"status" text NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"tip_amount" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"received_amount" numeric(12, 2),
	"change_amount" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"external_reference" text,
	"provider_name" text,
	"card_brand" text,
	"card_last_four" text,
	"authorization_reference" text,
	"other_description" text,
	"failure_reason" text,
	"recorded_by_user_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"business_date" date NOT NULL,
	"voided_by_user_id" uuid,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"idempotency_record_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settlement_tenders_type_valid" CHECK ("settlement_tenders"."tender_type" IN ('CASH', 'EXTERNAL_CARD', 'GIFT_CARD', 'HOUSE_ACCOUNT', 'OTHER')),
	CONSTRAINT "settlement_tenders_status_valid" CHECK ("settlement_tenders"."status" IN ('RECORDED', 'VOIDED', 'FAILED')),
	CONSTRAINT "settlement_tenders_amounts_valid" CHECK ("settlement_tenders"."amount" > 0 AND "settlement_tenders"."tip_amount" >= 0 AND "settlement_tenders"."change_amount" >= 0),
	CONSTRAINT "settlement_tenders_tip_types" CHECK ("settlement_tenders"."tip_amount" = 0 OR "settlement_tenders"."tender_type" IN ('CASH', 'EXTERNAL_CARD')),
	CONSTRAINT "settlement_tenders_cash_fields" CHECK (("settlement_tenders"."tender_type" = 'CASH') = ("settlement_tenders"."received_amount" IS NOT NULL)
        AND ("settlement_tenders"."tender_type" = 'CASH' OR "settlement_tenders"."change_amount" = 0)
        AND ("settlement_tenders"."received_amount" IS NULL
          OR "settlement_tenders"."change_amount" = "settlement_tenders"."received_amount" - "settlement_tenders"."amount" - "settlement_tenders"."tip_amount")),
	CONSTRAINT "settlement_tenders_failed_fields" CHECK (("settlement_tenders"."status" = 'FAILED') = ("settlement_tenders"."failure_reason" IS NOT NULL)
        AND ("settlement_tenders"."status" <> 'FAILED' OR ("settlement_tenders"."tender_type" = 'EXTERNAL_CARD' AND "settlement_tenders"."tip_amount" = 0))
        AND ("settlement_tenders"."failure_reason" IS NULL OR length(trim("settlement_tenders"."failure_reason")) > 0)),
	CONSTRAINT "settlement_tenders_other_description" CHECK (("settlement_tenders"."tender_type" <> 'OTHER' OR length(trim(coalesce("settlement_tenders"."other_description", ''))) > 0)
        AND ("settlement_tenders"."tender_type" = 'OTHER' OR "settlement_tenders"."other_description" IS NULL)),
	CONSTRAINT "settlement_tenders_card_fields" CHECK (("settlement_tenders"."tender_type" = 'EXTERNAL_CARD'
          OR ("settlement_tenders"."card_brand" IS NULL AND "settlement_tenders"."card_last_four" IS NULL))
        AND ("settlement_tenders"."card_last_four" IS NULL OR "settlement_tenders"."card_last_four" ~ '^[0-9]{4}$')),
	CONSTRAINT "settlement_tenders_no_pan" CHECK (("settlement_tenders"."external_reference" IS NULL OR "settlement_tenders"."external_reference" !~ '[0-9]{13,}') AND ("settlement_tenders"."provider_name" IS NULL OR "settlement_tenders"."provider_name" !~ '[0-9]{13,}')
        AND ("settlement_tenders"."card_brand" IS NULL OR "settlement_tenders"."card_brand" !~ '[0-9]{13,}') AND ("settlement_tenders"."authorization_reference" IS NULL OR "settlement_tenders"."authorization_reference" !~ '[0-9]{13,}')
        AND ("settlement_tenders"."other_description" IS NULL OR "settlement_tenders"."other_description" !~ '[0-9]{13,}') AND ("settlement_tenders"."failure_reason" IS NULL OR "settlement_tenders"."failure_reason" !~ '[0-9]{13,}')
        AND ("settlement_tenders"."void_reason" IS NULL OR "settlement_tenders"."void_reason" !~ '[0-9]{13,}')),
	CONSTRAINT "settlement_tenders_void_fields" CHECK (("settlement_tenders"."status" = 'VOIDED') = ("settlement_tenders"."voided_at" IS NOT NULL)
        AND ("settlement_tenders"."voided_at" IS NULL) = ("settlement_tenders"."voided_by_user_id" IS NULL)
        AND ("settlement_tenders"."voided_at" IS NULL) = ("settlement_tenders"."void_reason" IS NULL)
        AND ("settlement_tenders"."void_reason" IS NULL OR length(trim("settlement_tenders"."void_reason")) > 0))
);
--> statement-breakpoint
CREATE TABLE "order_settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"order_amount_snapshot" numeric(12, 2) NOT NULL,
	"tendered_amount" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"tip_amount" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"change_due" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"opened_by_user_id" uuid NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"opened_business_date" date NOT NULL,
	"completed_by_user_id" uuid,
	"completed_at" timestamp with time zone,
	"completed_business_date" date,
	"cancelled_by_user_id" uuid,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_settlements_status_valid" CHECK ("order_settlements"."status" IN ('OPEN', 'COMPLETED', 'CANCELLED')),
	CONSTRAINT "order_settlements_amounts_valid" CHECK ("order_settlements"."order_amount_snapshot" >= 0 AND "order_settlements"."tendered_amount" >= 0
        AND "order_settlements"."tip_amount" >= 0 AND "order_settlements"."change_due" >= 0
        AND "order_settlements"."tendered_amount" <= "order_settlements"."order_amount_snapshot"),
	CONSTRAINT "order_settlements_completed_fields" CHECK (("order_settlements"."status" = 'COMPLETED') = ("order_settlements"."completed_at" IS NOT NULL)
        AND ("order_settlements"."completed_at" IS NULL) = ("order_settlements"."completed_by_user_id" IS NULL)
        AND ("order_settlements"."completed_at" IS NULL) = ("order_settlements"."completed_business_date" IS NULL)
        AND ("order_settlements"."status" <> 'COMPLETED' OR "order_settlements"."tendered_amount" = "order_settlements"."order_amount_snapshot")),
	CONSTRAINT "order_settlements_cancelled_fields" CHECK (("order_settlements"."status" = 'CANCELLED') = ("order_settlements"."cancelled_at" IS NOT NULL)
        AND ("order_settlements"."cancelled_at" IS NULL) = ("order_settlements"."cancelled_by_user_id" IS NULL)
        AND ("order_settlements"."cancelled_at" IS NULL) = ("order_settlements"."cancel_reason" IS NULL)
        AND ("order_settlements"."cancel_reason" IS NULL OR length(trim("order_settlements"."cancel_reason")) > 0))
);
--> statement-breakpoint
ALTER TABLE "settlement_status_history" ADD CONSTRAINT "settlement_status_history_changed_by_user_id_users_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_status_history" ADD CONSTRAINT "settlement_status_history_settlement_fk" FOREIGN KEY ("settlement_id") REFERENCES "public"."order_settlements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_tenders" ADD CONSTRAINT "settlement_tenders_settlement_id_order_settlements_id_fk" FOREIGN KEY ("settlement_id") REFERENCES "public"."order_settlements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_tenders" ADD CONSTRAINT "settlement_tenders_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_tenders" ADD CONSTRAINT "settlement_tenders_voided_by_user_id_users_id_fk" FOREIGN KEY ("voided_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_tenders" ADD CONSTRAINT "settlement_tenders_idempotency_fk" FOREIGN KEY ("idempotency_record_id") REFERENCES "public"."idempotency_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_settlements" ADD CONSTRAINT "order_settlements_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_settlements" ADD CONSTRAINT "order_settlements_opened_by_user_id_users_id_fk" FOREIGN KEY ("opened_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_settlements" ADD CONSTRAINT "order_settlements_completed_by_user_id_users_id_fk" FOREIGN KEY ("completed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_settlements" ADD CONSTRAINT "order_settlements_cancelled_by_user_id_users_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_settlements" ADD CONSTRAINT "order_settlements_location_org_fk" FOREIGN KEY ("location_id","organization_id") REFERENCES "public"."locations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_settlements" ADD CONSTRAINT "order_settlements_order_org_fk" FOREIGN KEY ("order_id","organization_id") REFERENCES "public"."orders"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "settlement_status_history_settlement_idx" ON "settlement_status_history" USING btree ("settlement_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "settlement_tenders_idempotency_unique" ON "settlement_tenders" USING btree ("idempotency_record_id");--> statement-breakpoint
CREATE INDEX "settlement_tenders_settlement_idx" ON "settlement_tenders" USING btree ("settlement_id","recorded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "order_settlements_one_open_per_order" ON "order_settlements" USING btree ("order_id") WHERE "order_settlements"."status" = 'OPEN';--> statement-breakpoint
CREATE UNIQUE INDEX "order_settlements_one_completed_per_order" ON "order_settlements" USING btree ("order_id") WHERE "order_settlements"."status" = 'COMPLETED';--> statement-breakpoint
CREATE INDEX "order_settlements_order_idx" ON "order_settlements" USING btree ("order_id","opened_at");--> statement-breakpoint
CREATE INDEX "order_settlements_location_completed_date_idx" ON "order_settlements" USING btree ("location_id","completed_business_date");