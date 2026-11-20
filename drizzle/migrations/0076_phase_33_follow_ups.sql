CREATE TABLE "manager_log_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by_user_id" uuid,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "manager_log_categories_org_code_unique" UNIQUE("organization_id","code"),
	CONSTRAINT "manager_log_categories_code_valid" CHECK ("manager_log_categories"."code" ~ '^[A-Z][A-Z0-9_]{1,29}$'),
	CONSTRAINT "manager_log_categories_name_length" CHECK (char_length("manager_log_categories"."name") BETWEEN 1 AND 40)
);
--> statement-breakpoint
ALTER TABLE "guest_loyalty_entries" DROP CONSTRAINT "guest_loyalty_entries_kind_valid";--> statement-breakpoint
ALTER TABLE "guest_loyalty_entries" DROP CONSTRAINT "guest_loyalty_entries_sign_valid";--> statement-breakpoint
ALTER TABLE "manager_log_entries" DROP CONSTRAINT "manager_log_entries_category_valid";--> statement-breakpoint
ALTER TABLE "pre_shift_notes" DROP CONSTRAINT "pre_shift_notes_body_length";--> statement-breakpoint
ALTER TABLE "gift_card_programs" ADD COLUMN "dormancy_months" integer DEFAULT 36 NOT NULL;--> statement-breakpoint
ALTER TABLE "gift_cards" ADD COLUMN "code_source" text DEFAULT 'GENERATED' NOT NULL;--> statement-breakpoint
ALTER TABLE "guest_loyalty_entries" ADD COLUMN "refund_id" uuid;--> statement-breakpoint
ALTER TABLE "pre_shift_notes" ADD COLUMN "redacted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pre_shift_notes" ADD COLUMN "redacted_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "pre_shift_notes" ADD COLUMN "redaction_reason" text;--> statement-breakpoint
ALTER TABLE "manager_log_categories" ADD CONSTRAINT "manager_log_categories_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manager_log_categories" ADD CONSTRAINT "manager_log_categories_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manager_log_categories" ADD CONSTRAINT "manager_log_categories_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_loyalty_entries" ADD CONSTRAINT "guest_loyalty_entries_refund_id_order_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."order_refunds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pre_shift_notes" ADD CONSTRAINT "pre_shift_notes_redacted_by_user_id_users_id_fk" FOREIGN KEY ("redacted_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "guest_loyalty_entries_refund_reversed_unique" ON "guest_loyalty_entries" USING btree ("refund_id") WHERE "guest_loyalty_entries"."kind" = 'REFUND_REVERSED';--> statement-breakpoint
CREATE UNIQUE INDEX "guest_loyalty_entries_refund_restored_unique" ON "guest_loyalty_entries" USING btree ("refund_id") WHERE "guest_loyalty_entries"."kind" = 'REFUND_RESTORED';--> statement-breakpoint
ALTER TABLE "gift_card_programs" ADD CONSTRAINT "gift_card_programs_dormancy_valid" CHECK ("gift_card_programs"."dormancy_months" BETWEEN 12 AND 120);--> statement-breakpoint
ALTER TABLE "gift_cards" ADD CONSTRAINT "gift_cards_code_source_valid" CHECK ("gift_cards"."code_source" IN ('GENERATED', 'SUPPLIER'));--> statement-breakpoint
ALTER TABLE "guest_loyalty_entries" ADD CONSTRAINT "guest_loyalty_entries_refund_fields" CHECK (("guest_loyalty_entries"."kind" IN ('REFUND_REVERSED', 'REFUND_RESTORED')) = ("guest_loyalty_entries"."refund_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "guest_loyalty_entries" ADD CONSTRAINT "guest_loyalty_entries_kind_valid" CHECK ("guest_loyalty_entries"."kind" IN ('EARNED', 'REDEEMED', 'ADJUSTED', 'MERGED_OUT', 'MERGED_IN', 'ERASED', 'REFUND_REVERSED', 'REFUND_RESTORED'));--> statement-breakpoint
ALTER TABLE "guest_loyalty_entries" ADD CONSTRAINT "guest_loyalty_entries_sign_valid" CHECK (("guest_loyalty_entries"."kind" IN ('EARNED', 'MERGED_IN', 'REFUND_RESTORED') AND "guest_loyalty_entries"."points" > 0)
        OR ("guest_loyalty_entries"."kind" IN ('REDEEMED', 'MERGED_OUT', 'ERASED', 'REFUND_REVERSED') AND "guest_loyalty_entries"."points" < 0)
        OR "guest_loyalty_entries"."kind" = 'ADJUSTED');--> statement-breakpoint
ALTER TABLE "pre_shift_notes" ADD CONSTRAINT "pre_shift_notes_body_or_redaction" CHECK (("pre_shift_notes"."redacted_at" IS NULL AND "pre_shift_notes"."redacted_by_user_id" IS NULL AND "pre_shift_notes"."redaction_reason" IS NULL
          AND char_length("pre_shift_notes"."body") BETWEEN 1 AND 2000)
        OR ("pre_shift_notes"."redacted_at" IS NOT NULL AND "pre_shift_notes"."redacted_by_user_id" IS NOT NULL
          AND char_length("pre_shift_notes"."redaction_reason") BETWEEN 1 AND 500 AND "pre_shift_notes"."body" = ''
          AND "pre_shift_notes"."title" = 'Redacted' AND NOT "pre_shift_notes"."active"));