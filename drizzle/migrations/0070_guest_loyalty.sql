CREATE TABLE "guest_loyalty_balances" (
	"guest_profile_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"balance" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guest_loyalty_balances_non_negative" CHECK ("guest_loyalty_balances"."balance" >= 0)
);
--> statement-breakpoint
CREATE TABLE "guest_loyalty_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"guest_profile_id" uuid NOT NULL,
	"sequence" bigint GENERATED ALWAYS AS IDENTITY (sequence name "guest_loyalty_entries_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kind" text NOT NULL,
	"points" integer NOT NULL,
	"balance_after" integer NOT NULL,
	"location_id" uuid,
	"business_date" date,
	"guest_party_id" uuid,
	"order_id" uuid,
	"redemption_id" uuid,
	"related_profile_id" uuid,
	"eligible_subtotal" numeric(12, 2),
	"points_per_dollar_snapshot" integer,
	"points_per_visit_snapshot" integer,
	"reason" text,
	"created_by_user_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guest_loyalty_entries_sequence_unique" UNIQUE("sequence"),
	CONSTRAINT "guest_loyalty_entries_kind_valid" CHECK ("guest_loyalty_entries"."kind" IN ('EARNED', 'REDEEMED', 'ADJUSTED', 'MERGED_OUT', 'MERGED_IN', 'ERASED')),
	CONSTRAINT "guest_loyalty_entries_points_nonzero" CHECK ("guest_loyalty_entries"."points" <> 0),
	CONSTRAINT "guest_loyalty_entries_balance_non_negative" CHECK ("guest_loyalty_entries"."balance_after" >= 0),
	CONSTRAINT "guest_loyalty_entries_sign_valid" CHECK (("guest_loyalty_entries"."kind" IN ('EARNED', 'MERGED_IN') AND "guest_loyalty_entries"."points" > 0)
        OR ("guest_loyalty_entries"."kind" IN ('REDEEMED', 'MERGED_OUT', 'ERASED') AND "guest_loyalty_entries"."points" < 0)
        OR "guest_loyalty_entries"."kind" = 'ADJUSTED'),
	CONSTRAINT "guest_loyalty_entries_earned_fields" CHECK ("guest_loyalty_entries"."kind" <> 'EARNED' OR ("guest_loyalty_entries"."guest_party_id" IS NOT NULL AND "guest_loyalty_entries"."eligible_subtotal" IS NOT NULL
        AND "guest_loyalty_entries"."points_per_dollar_snapshot" IS NOT NULL AND "guest_loyalty_entries"."points_per_visit_snapshot" IS NOT NULL)),
	CONSTRAINT "guest_loyalty_entries_redeemed_fields" CHECK ("guest_loyalty_entries"."kind" <> 'REDEEMED' OR ("guest_loyalty_entries"."order_id" IS NOT NULL AND "guest_loyalty_entries"."redemption_id" IS NOT NULL)),
	CONSTRAINT "guest_loyalty_entries_merge_fields" CHECK ("guest_loyalty_entries"."kind" NOT IN ('MERGED_OUT', 'MERGED_IN') OR "guest_loyalty_entries"."related_profile_id" IS NOT NULL),
	CONSTRAINT "guest_loyalty_entries_reason_valid" CHECK (("guest_loyalty_entries"."kind" <> 'ADJUSTED' OR "guest_loyalty_entries"."reason" IS NOT NULL)
        AND ("guest_loyalty_entries"."reason" IS NULL OR length(trim("guest_loyalty_entries"."reason")) BETWEEN 1 AND 200)),
	CONSTRAINT "guest_loyalty_entries_reason_no_card_digits" CHECK (("guest_loyalty_entries"."reason" IS NULL OR "guest_loyalty_entries"."reason" !~ '[0-9]{13,}'))
);
--> statement-breakpoint
CREATE TABLE "guest_loyalty_programs" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"points_per_dollar" integer DEFAULT 1 NOT NULL,
	"points_per_visit" integer DEFAULT 0 NOT NULL,
	"enabled_at" timestamp with time zone,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "guest_loyalty_programs_rates_valid" CHECK ("guest_loyalty_programs"."points_per_dollar" BETWEEN 0 AND 100 AND "guest_loyalty_programs"."points_per_visit" BETWEEN 0 AND 100),
	CONSTRAINT "guest_loyalty_programs_enabled_at" CHECK (NOT "guest_loyalty_programs"."enabled" OR "guest_loyalty_programs"."enabled_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "guest_loyalty_redemptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"reward_id" uuid NOT NULL,
	"guest_profile_id" uuid NOT NULL,
	"guest_party_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"order_discount_id" uuid,
	"order_item_discount_id" uuid,
	"reward_name_snapshot" text NOT NULL,
	"points_cost_snapshot" integer NOT NULL,
	"redeemed_by_user_id" uuid NOT NULL,
	"redeemed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guest_loyalty_redemptions_order_discount_unique" UNIQUE("order_discount_id"),
	CONSTRAINT "guest_loyalty_redemptions_item_discount_unique" UNIQUE("order_item_discount_id"),
	CONSTRAINT "guest_loyalty_redemptions_one_discount" CHECK (("guest_loyalty_redemptions"."order_discount_id" IS NULL) <> ("guest_loyalty_redemptions"."order_item_discount_id" IS NULL)),
	CONSTRAINT "guest_loyalty_redemptions_cost_positive" CHECK ("guest_loyalty_redemptions"."points_cost_snapshot" > 0)
);
--> statement-breakpoint
CREATE TABLE "guest_loyalty_reward_number_counters" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"last_number" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "guest_loyalty_reward_counters_non_negative" CHECK ("guest_loyalty_reward_number_counters"."last_number" >= 0)
);
--> statement-breakpoint
CREATE TABLE "guest_loyalty_rewards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"reward_number" integer NOT NULL,
	"name" text NOT NULL,
	"points_cost" integer NOT NULL,
	"discount_definition_id" uuid NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "guest_loyalty_rewards_org_number_unique" UNIQUE("organization_id","reward_number"),
	CONSTRAINT "guest_loyalty_rewards_definition_unique" UNIQUE("discount_definition_id"),
	CONSTRAINT "guest_loyalty_rewards_number_positive" CHECK ("guest_loyalty_rewards"."reward_number" > 0),
	CONSTRAINT "guest_loyalty_rewards_cost_positive" CHECK ("guest_loyalty_rewards"."points_cost" > 0 AND "guest_loyalty_rewards"."points_cost" <= 1000000),
	CONSTRAINT "guest_loyalty_rewards_name_valid" CHECK (length(trim("guest_loyalty_rewards"."name")) BETWEEN 1 AND 80)
);
--> statement-breakpoint
ALTER TABLE "discount_definitions" ADD COLUMN "reward_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "guest_loyalty_balances" ADD CONSTRAINT "guest_loyalty_balances_profile_fk" FOREIGN KEY ("guest_profile_id","organization_id") REFERENCES "public"."guest_profiles"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_loyalty_entries" ADD CONSTRAINT "guest_loyalty_entries_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_loyalty_entries" ADD CONSTRAINT "guest_loyalty_entries_guest_party_id_guest_parties_id_fk" FOREIGN KEY ("guest_party_id") REFERENCES "public"."guest_parties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_loyalty_entries" ADD CONSTRAINT "guest_loyalty_entries_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_loyalty_entries" ADD CONSTRAINT "guest_loyalty_entries_related_profile_id_guest_profiles_id_fk" FOREIGN KEY ("related_profile_id") REFERENCES "public"."guest_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_loyalty_entries" ADD CONSTRAINT "guest_loyalty_entries_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_loyalty_entries" ADD CONSTRAINT "guest_loyalty_entries_profile_fk" FOREIGN KEY ("guest_profile_id","organization_id") REFERENCES "public"."guest_profiles"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_loyalty_entries" ADD CONSTRAINT "guest_loyalty_entries_redemption_fk" FOREIGN KEY ("redemption_id") REFERENCES "public"."guest_loyalty_redemptions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_loyalty_programs" ADD CONSTRAINT "guest_loyalty_programs_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_loyalty_programs" ADD CONSTRAINT "guest_loyalty_programs_org_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_loyalty_redemptions" ADD CONSTRAINT "guest_loyalty_redemptions_guest_party_id_guest_parties_id_fk" FOREIGN KEY ("guest_party_id") REFERENCES "public"."guest_parties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_loyalty_redemptions" ADD CONSTRAINT "guest_loyalty_redemptions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_loyalty_redemptions" ADD CONSTRAINT "guest_loyalty_redemptions_redeemed_by_user_id_users_id_fk" FOREIGN KEY ("redeemed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_loyalty_redemptions" ADD CONSTRAINT "guest_loyalty_redemptions_profile_fk" FOREIGN KEY ("guest_profile_id","organization_id") REFERENCES "public"."guest_profiles"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_loyalty_redemptions" ADD CONSTRAINT "guest_loyalty_redemptions_reward_fk" FOREIGN KEY ("reward_id") REFERENCES "public"."guest_loyalty_rewards"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_loyalty_redemptions" ADD CONSTRAINT "guest_loyalty_redemptions_order_discount_fk" FOREIGN KEY ("order_discount_id") REFERENCES "public"."order_discounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_loyalty_redemptions" ADD CONSTRAINT "guest_loyalty_redemptions_item_discount_fk" FOREIGN KEY ("order_item_discount_id") REFERENCES "public"."order_item_discounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_loyalty_reward_number_counters" ADD CONSTRAINT "guest_loyalty_reward_counters_org_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_loyalty_rewards" ADD CONSTRAINT "guest_loyalty_rewards_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_loyalty_rewards" ADD CONSTRAINT "guest_loyalty_rewards_definition_fk" FOREIGN KEY ("discount_definition_id") REFERENCES "public"."discount_definitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "guest_loyalty_entries_earned_party_unique" ON "guest_loyalty_entries" USING btree ("guest_party_id") WHERE "guest_loyalty_entries"."kind" = 'EARNED';--> statement-breakpoint
CREATE UNIQUE INDEX "guest_loyalty_entries_redeemed_unique" ON "guest_loyalty_entries" USING btree ("redemption_id") WHERE "guest_loyalty_entries"."kind" = 'REDEEMED';--> statement-breakpoint
CREATE INDEX "guest_loyalty_entries_profile_sequence_idx" ON "guest_loyalty_entries" USING btree ("guest_profile_id","sequence");--> statement-breakpoint
CREATE INDEX "guest_loyalty_entries_org_date_idx" ON "guest_loyalty_entries" USING btree ("organization_id","business_date");--> statement-breakpoint
CREATE INDEX "guest_loyalty_redemptions_profile_idx" ON "guest_loyalty_redemptions" USING btree ("guest_profile_id");--> statement-breakpoint
CREATE INDEX "guest_loyalty_redemptions_order_idx" ON "guest_loyalty_redemptions" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "guest_loyalty_redemptions_party_idx" ON "guest_loyalty_redemptions" USING btree ("guest_party_id");