CREATE TABLE "gift_card_escheatments" (
	"gift_card_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"state" text NOT NULL,
	"filing_reference" text NOT NULL,
	"report_date" date NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"location_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"reported_by_user_id" uuid NOT NULL,
	"reported_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gift_card_escheatments_state_valid" CHECK ("gift_card_escheatments"."state" ~ '^[A-Z]{2}$'),
	CONSTRAINT "gift_card_escheatments_reference_valid" CHECK (length(trim("gift_card_escheatments"."filing_reference")) BETWEEN 1 AND 60 AND "gift_card_escheatments"."filing_reference" !~ '[0-9]{13,}'),
	CONSTRAINT "gift_card_escheatments_amount_positive" CHECK ("gift_card_escheatments"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "gift_card_purchasers" (
	"gift_card_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text,
	"email" text,
	"phone" text,
	"address_line1" text,
	"address_line2" text,
	"city" text,
	"region" text,
	"postal_code" text,
	"country" text,
	"cleared_at" timestamp with time zone,
	"created_by_user_id" uuid NOT NULL,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "gift_card_purchasers_name_valid" CHECK ("gift_card_purchasers"."name" IS NULL OR (length(trim("gift_card_purchasers"."name")) BETWEEN 1 AND 120 AND "gift_card_purchasers"."name" !~ '[0-9]{13,}')),
	CONSTRAINT "gift_card_purchasers_email_valid" CHECK ("gift_card_purchasers"."email" IS NULL OR (length(trim("gift_card_purchasers"."email")) BETWEEN 1 AND 254 AND "gift_card_purchasers"."email" !~ '[0-9]{13,}')),
	CONSTRAINT "gift_card_purchasers_phone_valid" CHECK ("gift_card_purchasers"."phone" IS NULL OR (length(trim("gift_card_purchasers"."phone")) BETWEEN 1 AND 40 AND "gift_card_purchasers"."phone" !~ '[0-9]{13,}')),
	CONSTRAINT "gift_card_purchasers_line1_valid" CHECK ("gift_card_purchasers"."address_line1" IS NULL OR (length(trim("gift_card_purchasers"."address_line1")) BETWEEN 1 AND 120 AND "gift_card_purchasers"."address_line1" !~ '[0-9]{13,}')),
	CONSTRAINT "gift_card_purchasers_line2_valid" CHECK ("gift_card_purchasers"."address_line2" IS NULL OR (length(trim("gift_card_purchasers"."address_line2")) BETWEEN 1 AND 120 AND "gift_card_purchasers"."address_line2" !~ '[0-9]{13,}')),
	CONSTRAINT "gift_card_purchasers_city_valid" CHECK ("gift_card_purchasers"."city" IS NULL OR (length(trim("gift_card_purchasers"."city")) BETWEEN 1 AND 80 AND "gift_card_purchasers"."city" !~ '[0-9]{13,}')),
	CONSTRAINT "gift_card_purchasers_region_valid" CHECK ("gift_card_purchasers"."region" IS NULL OR (length(trim("gift_card_purchasers"."region")) BETWEEN 1 AND 80 AND "gift_card_purchasers"."region" !~ '[0-9]{13,}')),
	CONSTRAINT "gift_card_purchasers_postal_valid" CHECK ("gift_card_purchasers"."postal_code" IS NULL OR (length(trim("gift_card_purchasers"."postal_code")) BETWEEN 1 AND 20 AND "gift_card_purchasers"."postal_code" !~ '[0-9]{13,}')),
	CONSTRAINT "gift_card_purchasers_country_valid" CHECK ("gift_card_purchasers"."country" IS NULL OR (length(trim("gift_card_purchasers"."country")) BETWEEN 1 AND 60 AND "gift_card_purchasers"."country" !~ '[0-9]{13,}')),
	CONSTRAINT "gift_card_purchasers_cleared" CHECK ("gift_card_purchasers"."cleared_at" IS NULL OR ("gift_card_purchasers"."name" IS NULL AND "gift_card_purchasers"."email" IS NULL AND "gift_card_purchasers"."phone" IS NULL
        AND "gift_card_purchasers"."address_line1" IS NULL AND "gift_card_purchasers"."address_line2" IS NULL AND "gift_card_purchasers"."city" IS NULL
        AND "gift_card_purchasers"."region" IS NULL AND "gift_card_purchasers"."postal_code" IS NULL AND "gift_card_purchasers"."country" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "gift_card_stock_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"batch_number" integer NOT NULL,
	"location_id" uuid NOT NULL,
	"description" text NOT NULL,
	"card_count" integer NOT NULL,
	"registered_by_user_id" uuid NOT NULL,
	"registered_at" timestamp with time zone NOT NULL,
	"idempotency_record_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gift_card_stock_batches_id_org_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "gift_card_stock_batches_org_number_unique" UNIQUE("organization_id","batch_number"),
	CONSTRAINT "gift_card_stock_batches_number_positive" CHECK ("gift_card_stock_batches"."batch_number" > 0),
	CONSTRAINT "gift_card_stock_batches_count_valid" CHECK ("gift_card_stock_batches"."card_count" BETWEEN 1 AND 1000),
	CONSTRAINT "gift_card_stock_batches_description_valid" CHECK (length(trim("gift_card_stock_batches"."description")) BETWEEN 1 AND 80 AND ("gift_card_stock_batches"."description" IS NULL OR "gift_card_stock_batches"."description" !~ '[0-9]{13,}'))
);
--> statement-breakpoint
CREATE TABLE "free_text_redactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"table_name" text NOT NULL,
	"row_id" uuid NOT NULL,
	"column_name" text NOT NULL,
	"reason" text NOT NULL,
	"redacted_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "free_text_redactions_table_valid" CHECK ("free_text_redactions"."table_name" IN ('guest_parties', 'reservations', 'waitlist_entries', 'table_sessions', 'orders', 'order_items', 'kitchen_ticket_items', 'shifts', 'shift_assignments', 'gift_card_purchasers')),
	CONSTRAINT "free_text_redactions_column_valid" CHECK ("free_text_redactions"."column_name" ~ '^[a-z][a-z0-9_]{0,62}$'),
	CONSTRAINT "free_text_redactions_reason_valid" CHECK (length(trim("free_text_redactions"."reason")) BETWEEN 1 AND 200)
);
--> statement-breakpoint
ALTER TABLE "gift_card_entries" DROP CONSTRAINT "gift_card_entries_kind_valid";--> statement-breakpoint
ALTER TABLE "gift_card_entries" DROP CONSTRAINT "gift_card_entries_sign_valid";--> statement-breakpoint
ALTER TABLE "gift_card_entries" DROP CONSTRAINT "gift_card_entries_reason";--> statement-breakpoint
ALTER TABLE "gift_card_number_counters" DROP CONSTRAINT "gift_card_number_counters_non_negative";--> statement-breakpoint
ALTER TABLE "gift_cards" DROP CONSTRAINT "gift_cards_status_valid";--> statement-breakpoint
ALTER TABLE "gift_cards" ALTER COLUMN "issued_location_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "gift_cards" ALTER COLUMN "issued_by_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "gift_cards" ALTER COLUMN "issued_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "gift_card_number_counters" ADD COLUMN "last_batch_number" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "gift_card_programs" ADD COLUMN "supplier_stock_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "gift_cards" ADD COLUMN "stock_batch_id" uuid;--> statement-breakpoint
ALTER TABLE "gift_cards" ADD COLUMN "printed_serial" text;--> statement-breakpoint
ALTER TABLE "gift_card_escheatments" ADD CONSTRAINT "gift_card_escheatments_reported_by_user_id_users_id_fk" FOREIGN KEY ("reported_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_card_escheatments" ADD CONSTRAINT "gift_card_escheatments_card_org_fk" FOREIGN KEY ("gift_card_id","organization_id") REFERENCES "public"."gift_cards"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_card_escheatments" ADD CONSTRAINT "gift_card_escheatments_location_org_fk" FOREIGN KEY ("location_id","organization_id") REFERENCES "public"."locations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_card_purchasers" ADD CONSTRAINT "gift_card_purchasers_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_card_purchasers" ADD CONSTRAINT "gift_card_purchasers_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_card_purchasers" ADD CONSTRAINT "gift_card_purchasers_card_org_fk" FOREIGN KEY ("gift_card_id","organization_id") REFERENCES "public"."gift_cards"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_card_stock_batches" ADD CONSTRAINT "gift_card_stock_batches_registered_by_user_id_users_id_fk" FOREIGN KEY ("registered_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_card_stock_batches" ADD CONSTRAINT "gift_card_stock_batches_location_org_fk" FOREIGN KEY ("location_id","organization_id") REFERENCES "public"."locations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_card_stock_batches" ADD CONSTRAINT "gift_card_stock_batches_idempotency_fk" FOREIGN KEY ("idempotency_record_id") REFERENCES "public"."idempotency_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "free_text_redactions" ADD CONSTRAINT "free_text_redactions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "free_text_redactions" ADD CONSTRAINT "free_text_redactions_redacted_by_user_id_users_id_fk" FOREIGN KEY ("redacted_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gift_card_stock_batches_idempotency_unique" ON "gift_card_stock_batches" USING btree ("idempotency_record_id");--> statement-breakpoint
CREATE INDEX "free_text_redactions_row_idx" ON "free_text_redactions" USING btree ("table_name","row_id","column_name");--> statement-breakpoint
ALTER TABLE "gift_cards" ADD CONSTRAINT "gift_cards_stock_batch_org_fk" FOREIGN KEY ("stock_batch_id","organization_id") REFERENCES "public"."gift_card_stock_batches"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gift_cards_stock_batch_idx" ON "gift_cards" USING btree ("stock_batch_id");--> statement-breakpoint
ALTER TABLE "gift_card_entries" ADD CONSTRAINT "gift_card_entries_kind_valid" CHECK ("gift_card_entries"."kind" IN ('ISSUED', 'RELOADED', 'SALE_VOIDED', 'REDEEMED', 'REDEMPTION_VOIDED',
        'REFUNDED', 'REFUND_VOIDED', 'ADJUSTED', 'CASHED_OUT', 'ESCHEATED'));--> statement-breakpoint
ALTER TABLE "gift_card_entries" ADD CONSTRAINT "gift_card_entries_sign_valid" CHECK (("gift_card_entries"."kind" IN ('ISSUED', 'RELOADED', 'REDEMPTION_VOIDED', 'REFUNDED') AND "gift_card_entries"."amount" > 0)
        OR ("gift_card_entries"."kind" IN ('SALE_VOIDED', 'REDEEMED', 'REFUND_VOIDED', 'CASHED_OUT', 'ESCHEATED') AND "gift_card_entries"."amount" < 0)
        OR "gift_card_entries"."kind" = 'ADJUSTED');--> statement-breakpoint
ALTER TABLE "gift_card_entries" ADD CONSTRAINT "gift_card_entries_reason" CHECK (("gift_card_entries"."kind" NOT IN ('SALE_VOIDED', 'ADJUSTED', 'CASHED_OUT', 'ESCHEATED')
          OR length(trim(coalesce("gift_card_entries"."reason", ''))) > 0)
        AND ("gift_card_entries"."reason" IS NULL OR "gift_card_entries"."reason" !~ '[0-9]{13,}'));--> statement-breakpoint
ALTER TABLE "gift_card_number_counters" ADD CONSTRAINT "gift_card_number_counters_non_negative" CHECK ("gift_card_number_counters"."last_number" >= 0 AND "gift_card_number_counters"."last_batch_number" >= 0);--> statement-breakpoint
ALTER TABLE "gift_cards" ADD CONSTRAINT "gift_cards_stock_unissued" CHECK (("gift_cards"."issued_at" IS NULL) = ("gift_cards"."issued_location_id" IS NULL)
        AND ("gift_cards"."issued_at" IS NULL) = ("gift_cards"."issued_by_user_id" IS NULL)
        AND ("gift_cards"."status" <> 'STOCK' OR ("gift_cards"."issued_at" IS NULL AND "gift_cards"."balance" = 0))
        AND ("gift_cards"."status" <> 'ACTIVE' OR "gift_cards"."issued_at" IS NOT NULL)
        AND ("gift_cards"."issued_at" IS NOT NULL OR "gift_cards"."stock_batch_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "gift_cards" ADD CONSTRAINT "gift_cards_printed_serial_valid" CHECK ("gift_cards"."printed_serial" IS NULL OR (length(trim("gift_cards"."printed_serial")) BETWEEN 1 AND 40 AND ("gift_cards"."printed_serial" IS NULL OR "gift_cards"."printed_serial" !~ '[0-9]{13,}')));--> statement-breakpoint
ALTER TABLE "gift_cards" ADD CONSTRAINT "gift_cards_status_valid" CHECK ("gift_cards"."status" IN ('ACTIVE', 'INACTIVE', 'STOCK'));