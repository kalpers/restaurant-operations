CREATE TABLE "gift_card_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"gift_card_id" uuid NOT NULL,
	"sequence" bigint GENERATED ALWAYS AS IDENTITY (sequence name "gift_card_entries_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kind" text NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"balance_after" numeric(12, 2) NOT NULL,
	"location_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"sale_id" uuid,
	"tender_id" uuid,
	"refund_id" uuid,
	"cash_drawer_session_id" uuid,
	"reason" text,
	"created_by_user_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gift_card_entries_kind_sale_unique" UNIQUE("kind","sale_id"),
	CONSTRAINT "gift_card_entries_kind_tender_unique" UNIQUE("kind","tender_id"),
	CONSTRAINT "gift_card_entries_kind_refund_unique" UNIQUE("kind","refund_id"),
	CONSTRAINT "gift_card_entries_kind_valid" CHECK ("gift_card_entries"."kind" IN ('ISSUED', 'RELOADED', 'SALE_VOIDED', 'REDEEMED', 'REDEMPTION_VOIDED',
        'REFUNDED', 'REFUND_VOIDED', 'ADJUSTED', 'CASHED_OUT')),
	CONSTRAINT "gift_card_entries_amount_nonzero" CHECK ("gift_card_entries"."amount" <> 0),
	CONSTRAINT "gift_card_entries_balance_non_negative" CHECK ("gift_card_entries"."balance_after" >= 0),
	CONSTRAINT "gift_card_entries_sign_valid" CHECK (("gift_card_entries"."kind" IN ('ISSUED', 'RELOADED', 'REDEMPTION_VOIDED', 'REFUNDED') AND "gift_card_entries"."amount" > 0)
        OR ("gift_card_entries"."kind" IN ('SALE_VOIDED', 'REDEEMED', 'REFUND_VOIDED', 'CASHED_OUT') AND "gift_card_entries"."amount" < 0)
        OR "gift_card_entries"."kind" = 'ADJUSTED'),
	CONSTRAINT "gift_card_entries_references" CHECK ((("gift_card_entries"."kind" IN ('ISSUED', 'RELOADED', 'SALE_VOIDED')) = ("gift_card_entries"."sale_id" IS NOT NULL))
        AND (("gift_card_entries"."kind" IN ('REDEEMED', 'REDEMPTION_VOIDED')) = ("gift_card_entries"."tender_id" IS NOT NULL))
        AND (("gift_card_entries"."kind" IN ('REFUNDED', 'REFUND_VOIDED')) = ("gift_card_entries"."refund_id" IS NOT NULL))
        AND ("gift_card_entries"."kind" = 'CASHED_OUT' OR "gift_card_entries"."cash_drawer_session_id" IS NULL)),
	CONSTRAINT "gift_card_entries_reason" CHECK (("gift_card_entries"."kind" NOT IN ('SALE_VOIDED', 'ADJUSTED', 'CASHED_OUT')
          OR length(trim(coalesce("gift_card_entries"."reason", ''))) > 0)
        AND ("gift_card_entries"."reason" IS NULL OR "gift_card_entries"."reason" !~ '[0-9]{13,}'))
);
--> statement-breakpoint
CREATE TABLE "gift_card_number_counters" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"last_number" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "gift_card_number_counters_non_negative" CHECK ("gift_card_number_counters"."last_number" >= 0)
);
--> statement-breakpoint
CREATE TABLE "gift_card_programs" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"max_balance" numeric(12, 2) DEFAULT '500.00' NOT NULL,
	"enabled_at" timestamp with time zone,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "gift_card_programs_max_valid" CHECK ("gift_card_programs"."max_balance" >= 1.00 AND "gift_card_programs"."max_balance" <= 10000.00),
	CONSTRAINT "gift_card_programs_enabled_at" CHECK (NOT "gift_card_programs"."enabled" OR "gift_card_programs"."enabled_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "gift_card_sales" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"gift_card_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"tender_type" text NOT NULL,
	"received_amount" numeric(12, 2),
	"change_amount" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"external_reference" text,
	"provider_name" text,
	"card_brand" text,
	"card_last_four" text,
	"authorization_reference" text,
	"other_description" text,
	"cash_drawer_session_id" uuid,
	"business_date" date NOT NULL,
	"status" text DEFAULT 'RECORDED' NOT NULL,
	"sold_by_user_id" uuid NOT NULL,
	"sold_at" timestamp with time zone NOT NULL,
	"voided_by_user_id" uuid,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"voided_business_date" date,
	"idempotency_record_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "gift_card_sales_kind_valid" CHECK ("gift_card_sales"."kind" IN ('ISSUED', 'RELOADED')),
	CONSTRAINT "gift_card_sales_type_valid" CHECK ("gift_card_sales"."tender_type" IN ('CASH', 'EXTERNAL_CARD', 'OTHER')),
	CONSTRAINT "gift_card_sales_status_valid" CHECK ("gift_card_sales"."status" IN ('RECORDED', 'VOIDED')),
	CONSTRAINT "gift_card_sales_amount_positive" CHECK ("gift_card_sales"."amount" > 0 AND "gift_card_sales"."change_amount" >= 0),
	CONSTRAINT "gift_card_sales_cash_fields" CHECK (("gift_card_sales"."tender_type" = 'CASH') = ("gift_card_sales"."received_amount" IS NOT NULL)
        AND ("gift_card_sales"."tender_type" = 'CASH' OR "gift_card_sales"."change_amount" = 0)
        AND ("gift_card_sales"."received_amount" IS NULL OR "gift_card_sales"."change_amount" = "gift_card_sales"."received_amount" - "gift_card_sales"."amount")
        AND ("gift_card_sales"."tender_type" = 'CASH' OR "gift_card_sales"."cash_drawer_session_id" IS NULL)
        AND ("gift_card_sales"."tender_type" <> 'CASH' OR "gift_card_sales"."external_reference" IS NULL)),
	CONSTRAINT "gift_card_sales_card_fields" CHECK (("gift_card_sales"."tender_type" = 'EXTERNAL_CARD'
          OR ("gift_card_sales"."card_brand" IS NULL AND "gift_card_sales"."card_last_four" IS NULL
            AND "gift_card_sales"."provider_name" IS NULL AND "gift_card_sales"."authorization_reference" IS NULL))
        AND ("gift_card_sales"."card_last_four" IS NULL OR "gift_card_sales"."card_last_four" ~ '^[0-9]{4}$')),
	CONSTRAINT "gift_card_sales_other_description" CHECK (("gift_card_sales"."tender_type" <> 'OTHER' OR length(trim(coalesce("gift_card_sales"."other_description", ''))) > 0)
        AND ("gift_card_sales"."tender_type" = 'OTHER' OR "gift_card_sales"."other_description" IS NULL)),
	CONSTRAINT "gift_card_sales_no_pan" CHECK (("gift_card_sales"."external_reference" IS NULL OR "gift_card_sales"."external_reference" !~ '[0-9]{13,}') AND ("gift_card_sales"."provider_name" IS NULL OR "gift_card_sales"."provider_name" !~ '[0-9]{13,}')
        AND ("gift_card_sales"."card_brand" IS NULL OR "gift_card_sales"."card_brand" !~ '[0-9]{13,}') AND ("gift_card_sales"."authorization_reference" IS NULL OR "gift_card_sales"."authorization_reference" !~ '[0-9]{13,}')
        AND ("gift_card_sales"."other_description" IS NULL OR "gift_card_sales"."other_description" !~ '[0-9]{13,}') AND ("gift_card_sales"."void_reason" IS NULL OR "gift_card_sales"."void_reason" !~ '[0-9]{13,}')),
	CONSTRAINT "gift_card_sales_void_fields" CHECK (("gift_card_sales"."status" = 'VOIDED') = ("gift_card_sales"."voided_at" IS NOT NULL)
        AND ("gift_card_sales"."voided_at" IS NULL) = ("gift_card_sales"."voided_by_user_id" IS NULL)
        AND ("gift_card_sales"."voided_at" IS NULL) = ("gift_card_sales"."void_reason" IS NULL)
        AND ("gift_card_sales"."voided_at" IS NULL) = ("gift_card_sales"."voided_business_date" IS NULL)
        AND ("gift_card_sales"."void_reason" IS NULL OR length(trim("gift_card_sales"."void_reason")) > 0))
);
--> statement-breakpoint
CREATE TABLE "gift_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"card_number" integer NOT NULL,
	"code_hash" text NOT NULL,
	"code_last_four" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"balance" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"issued_location_id" uuid NOT NULL,
	"issued_by_user_id" uuid NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"status_reason" text,
	"code_replaced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "gift_cards_id_org_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "gift_cards_org_number_unique" UNIQUE("organization_id","card_number"),
	CONSTRAINT "gift_cards_number_positive" CHECK ("gift_cards"."card_number" > 0),
	CONSTRAINT "gift_cards_code_hash_valid" CHECK ("gift_cards"."code_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "gift_cards_code_last_four_valid" CHECK ("gift_cards"."code_last_four" ~ '^[0-9A-Z]{4}$'),
	CONSTRAINT "gift_cards_status_valid" CHECK ("gift_cards"."status" IN ('ACTIVE', 'INACTIVE')),
	CONSTRAINT "gift_cards_balance_non_negative" CHECK ("gift_cards"."balance" >= 0),
	CONSTRAINT "gift_cards_status_reason" CHECK (("gift_cards"."status_reason" IS NULL OR length(trim("gift_cards"."status_reason")) > 0) AND ("gift_cards"."status_reason" IS NULL OR "gift_cards"."status_reason" !~ '[0-9]{13,}'))
);
--> statement-breakpoint
ALTER TABLE "order_refunds" ADD COLUMN "gift_card_id" uuid;--> statement-breakpoint
ALTER TABLE "settlement_tenders" ADD COLUMN "gift_card_id" uuid;--> statement-breakpoint
ALTER TABLE "gift_card_entries" ADD CONSTRAINT "gift_card_entries_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_card_entries" ADD CONSTRAINT "gift_card_entries_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_card_entries" ADD CONSTRAINT "gift_card_entries_card_org_fk" FOREIGN KEY ("gift_card_id","organization_id") REFERENCES "public"."gift_cards"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_card_entries" ADD CONSTRAINT "gift_card_entries_sale_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."gift_card_sales"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_card_entries" ADD CONSTRAINT "gift_card_entries_tender_fk" FOREIGN KEY ("tender_id") REFERENCES "public"."settlement_tenders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_card_entries" ADD CONSTRAINT "gift_card_entries_refund_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."order_refunds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_card_entries" ADD CONSTRAINT "gift_card_entries_drawer_session_fk" FOREIGN KEY ("cash_drawer_session_id") REFERENCES "public"."cash_drawer_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_card_number_counters" ADD CONSTRAINT "gift_card_number_counters_org_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_card_programs" ADD CONSTRAINT "gift_card_programs_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_card_programs" ADD CONSTRAINT "gift_card_programs_org_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_card_sales" ADD CONSTRAINT "gift_card_sales_sold_by_user_id_users_id_fk" FOREIGN KEY ("sold_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_card_sales" ADD CONSTRAINT "gift_card_sales_voided_by_user_id_users_id_fk" FOREIGN KEY ("voided_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_card_sales" ADD CONSTRAINT "gift_card_sales_card_org_fk" FOREIGN KEY ("gift_card_id","organization_id") REFERENCES "public"."gift_cards"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_card_sales" ADD CONSTRAINT "gift_card_sales_location_org_fk" FOREIGN KEY ("location_id","organization_id") REFERENCES "public"."locations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_card_sales" ADD CONSTRAINT "gift_card_sales_drawer_session_fk" FOREIGN KEY ("cash_drawer_session_id") REFERENCES "public"."cash_drawer_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_card_sales" ADD CONSTRAINT "gift_card_sales_idempotency_fk" FOREIGN KEY ("idempotency_record_id") REFERENCES "public"."idempotency_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_cards" ADD CONSTRAINT "gift_cards_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_cards" ADD CONSTRAINT "gift_cards_issued_by_user_id_users_id_fk" FOREIGN KEY ("issued_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_cards" ADD CONSTRAINT "gift_cards_location_org_fk" FOREIGN KEY ("issued_location_id","organization_id") REFERENCES "public"."locations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gift_card_entries_card_idx" ON "gift_card_entries" USING btree ("gift_card_id","sequence");--> statement-breakpoint
CREATE INDEX "gift_card_entries_location_date_idx" ON "gift_card_entries" USING btree ("location_id","business_date");--> statement-breakpoint
CREATE INDEX "gift_card_entries_drawer_session_idx" ON "gift_card_entries" USING btree ("cash_drawer_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gift_card_sales_idempotency_unique" ON "gift_card_sales" USING btree ("idempotency_record_id");--> statement-breakpoint
CREATE INDEX "gift_card_sales_card_idx" ON "gift_card_sales" USING btree ("gift_card_id","sold_at");--> statement-breakpoint
CREATE INDEX "gift_card_sales_location_date_idx" ON "gift_card_sales" USING btree ("location_id","business_date");--> statement-breakpoint
CREATE INDEX "gift_card_sales_drawer_session_idx" ON "gift_card_sales" USING btree ("cash_drawer_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gift_cards_code_hash_unique" ON "gift_cards" USING btree ("code_hash");--> statement-breakpoint
ALTER TABLE "order_refunds" ADD CONSTRAINT "order_refunds_gift_card_fk" FOREIGN KEY ("gift_card_id") REFERENCES "public"."gift_cards"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_tenders" ADD CONSTRAINT "settlement_tenders_gift_card_fk" FOREIGN KEY ("gift_card_id") REFERENCES "public"."gift_cards"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_refunds_gift_card_idx" ON "order_refunds" USING btree ("gift_card_id");--> statement-breakpoint
CREATE INDEX "settlement_tenders_gift_card_idx" ON "settlement_tenders" USING btree ("gift_card_id");--> statement-breakpoint
ALTER TABLE "order_refunds" ADD CONSTRAINT "order_refunds_gift_card_type" CHECK ("order_refunds"."gift_card_id" IS NULL OR ("order_refunds"."tender_type" = 'GIFT_CARD' AND "order_refunds"."tip_amount" = 0));--> statement-breakpoint
ALTER TABLE "settlement_tenders" ADD CONSTRAINT "settlement_tenders_gift_card_type" CHECK ("settlement_tenders"."gift_card_id" IS NULL OR ("settlement_tenders"."tender_type" = 'GIFT_CARD' AND "settlement_tenders"."external_reference" IS NULL));