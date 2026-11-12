CREATE TABLE "guest_party_allergies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"guest_party_id" uuid NOT NULL,
	"allergen_id" uuid NOT NULL,
	"severity" text NOT NULL,
	"note" text,
	"source" text NOT NULL,
	"recorded_by_user_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guest_party_allergies_party_allergen_unique" UNIQUE("guest_party_id","allergen_id"),
	CONSTRAINT "guest_party_allergies_severity_valid" CHECK ("guest_party_allergies"."severity" IN ('SEVERE', 'ALLERGY')),
	CONSTRAINT "guest_party_allergies_source_valid" CHECK ("guest_party_allergies"."source" IN ('PROFILE', 'RECORDED')),
	CONSTRAINT "guest_party_allergies_note_valid" CHECK ("guest_party_allergies"."note" IS NULL OR (length("guest_party_allergies"."note") <= 200 AND "guest_party_allergies"."note" !~ '[0-9]{13,}'))
);
--> statement-breakpoint
CREATE TABLE "guest_profile_allergies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"guest_profile_id" uuid NOT NULL,
	"allergen_id" uuid NOT NULL,
	"severity" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guest_profile_allergies_profile_allergen_unique" UNIQUE("guest_profile_id","allergen_id"),
	CONSTRAINT "guest_profile_allergies_severity_valid" CHECK ("guest_profile_allergies"."severity" IN ('SEVERE', 'ALLERGY')),
	CONSTRAINT "guest_profile_allergies_note_valid" CHECK ("guest_profile_allergies"."note" IS NULL OR (length("guest_profile_allergies"."note") <= 200 AND "guest_profile_allergies"."note" !~ '[0-9]{13,}'))
);
--> statement-breakpoint
CREATE TABLE "guest_profile_merges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"merged_profile_id" uuid NOT NULL,
	"kept_profile_id" uuid NOT NULL,
	"parties_moved" integer NOT NULL,
	"allergies_added" integer NOT NULL,
	"reason" text NOT NULL,
	"merged_by_user_id" uuid NOT NULL,
	"merged_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guest_profile_merges_merged_unique" UNIQUE("merged_profile_id"),
	CONSTRAINT "guest_profile_merges_distinct" CHECK ("guest_profile_merges"."merged_profile_id" <> "guest_profile_merges"."kept_profile_id"),
	CONSTRAINT "guest_profile_merges_counts" CHECK ("guest_profile_merges"."parties_moved" >= 0 AND "guest_profile_merges"."allergies_added" >= 0),
	CONSTRAINT "guest_profile_merges_reason_valid" CHECK (length(trim("guest_profile_merges"."reason")) BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE TABLE "guest_profile_number_counters" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"last_number" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "guest_profile_number_counters_non_negative" CHECK ("guest_profile_number_counters"."last_number" >= 0)
);
--> statement-breakpoint
CREATE TABLE "guest_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"profile_number" integer NOT NULL,
	"display_name" text NOT NULL,
	"phone" text,
	"phone_normalized" text,
	"email" text,
	"email_normalized" text,
	"vip" boolean DEFAULT false NOT NULL,
	"vip_reason" text,
	"preferences" text,
	"notes" text,
	"other_dietary_needs" text,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"merged_into_profile_id" uuid,
	"erased_at" timestamp with time zone,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "guest_profiles_organization_id_profile_number_unique" UNIQUE("organization_id","profile_number"),
	CONSTRAINT "guest_profiles_id_organization_id_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "guest_profiles_status_valid" CHECK ("guest_profiles"."status" IN ('ACTIVE', 'MERGED', 'ERASED')),
	CONSTRAINT "guest_profiles_profile_number_positive" CHECK ("guest_profiles"."profile_number" > 0),
	CONSTRAINT "guest_profiles_display_name_valid" CHECK (length(trim("guest_profiles"."display_name")) BETWEEN 1 AND 120),
	CONSTRAINT "guest_profiles_text_lengths" CHECK (("guest_profiles"."phone" IS NULL OR length("guest_profiles"."phone") <= 40)
        AND ("guest_profiles"."email" IS NULL OR length("guest_profiles"."email") <= 254)
        AND ("guest_profiles"."vip_reason" IS NULL OR length("guest_profiles"."vip_reason") <= 200)
        AND ("guest_profiles"."preferences" IS NULL OR length("guest_profiles"."preferences") <= 500)
        AND ("guest_profiles"."notes" IS NULL OR length("guest_profiles"."notes") <= 1000)
        AND ("guest_profiles"."other_dietary_needs" IS NULL OR length("guest_profiles"."other_dietary_needs") <= 500)),
	CONSTRAINT "guest_profiles_phone_normalized_format" CHECK ("guest_profiles"."phone_normalized" IS NULL OR "guest_profiles"."phone_normalized" ~ '^[+]?[0-9]{3,15}$'),
	CONSTRAINT "guest_profiles_no_card_digits" CHECK (("guest_profiles"."email" IS NULL OR "guest_profiles"."email" !~ '[0-9]{13,}') AND ("guest_profiles"."vip_reason" IS NULL OR "guest_profiles"."vip_reason" !~ '[0-9]{13,}') AND ("guest_profiles"."preferences" IS NULL OR "guest_profiles"."preferences" !~ '[0-9]{13,}')
        AND ("guest_profiles"."notes" IS NULL OR "guest_profiles"."notes" !~ '[0-9]{13,}') AND ("guest_profiles"."other_dietary_needs" IS NULL OR "guest_profiles"."other_dietary_needs" !~ '[0-9]{13,}')),
	CONSTRAINT "guest_profiles_merge_consistent" CHECK (("guest_profiles"."status" = 'MERGED') = ("guest_profiles"."merged_into_profile_id" IS NOT NULL)
        AND ("guest_profiles"."merged_into_profile_id" IS NULL OR "guest_profiles"."merged_into_profile_id" <> "guest_profiles"."id")),
	CONSTRAINT "guest_profiles_erase_consistent" CHECK (("guest_profiles"."status" <> 'ERASED' OR "guest_profiles"."erased_at" IS NOT NULL) AND ("guest_profiles"."status" <> 'ACTIVE' OR "guest_profiles"."erased_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "order_allergies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"allergen_id" uuid NOT NULL,
	"severity" text NOT NULL,
	"note" text,
	"recorded_by_user_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_allergies_order_allergen_unique" UNIQUE("order_id","allergen_id"),
	CONSTRAINT "order_allergies_severity_valid" CHECK ("order_allergies"."severity" IN ('SEVERE', 'ALLERGY')),
	CONSTRAINT "order_allergies_note_valid" CHECK ("order_allergies"."note" IS NULL OR (length("order_allergies"."note") <= 200 AND "order_allergies"."note" !~ '[0-9]{13,}'))
);
--> statement-breakpoint
CREATE TABLE "order_item_allergens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_item_id" uuid NOT NULL,
	"allergen_id" uuid NOT NULL,
	"allergen_code_snapshot" text NOT NULL,
	"allergen_name_snapshot" text NOT NULL,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_item_allergens_item_allergen_unique" UNIQUE("order_item_id","allergen_id"),
	CONSTRAINT "order_item_allergens_kind_valid" CHECK ("order_item_allergens"."kind" IN ('CONTAINS', 'MAY_CONTAIN')),
	CONSTRAINT "order_item_allergens_source_valid" CHECK ("order_item_allergens"."source" IN ('DERIVED', 'DECLARED'))
);
--> statement-breakpoint
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_category_valid";--> statement-breakpoint
ALTER TABLE "guest_parties" ADD COLUMN "guest_profile_id" uuid;--> statement-breakpoint
ALTER TABLE "kitchen_ticket_items" ADD COLUMN "allergy_alert_snapshot" text;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "allergen_label_incomplete_snapshot" boolean;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "allergy_acknowledged_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "allergy_acknowledged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "allergy_conflict_snapshot" text;--> statement-breakpoint
ALTER TABLE "guest_party_allergies" ADD CONSTRAINT "guest_party_allergies_guest_party_id_guest_parties_id_fk" FOREIGN KEY ("guest_party_id") REFERENCES "public"."guest_parties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_party_allergies" ADD CONSTRAINT "guest_party_allergies_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_party_allergies" ADD CONSTRAINT "guest_party_allergies_allergen_org_fk" FOREIGN KEY ("allergen_id","organization_id") REFERENCES "public"."allergens"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_profile_allergies" ADD CONSTRAINT "guest_profile_allergies_profile_org_fk" FOREIGN KEY ("guest_profile_id","organization_id") REFERENCES "public"."guest_profiles"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_profile_allergies" ADD CONSTRAINT "guest_profile_allergies_allergen_org_fk" FOREIGN KEY ("allergen_id","organization_id") REFERENCES "public"."allergens"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_profile_merges" ADD CONSTRAINT "guest_profile_merges_merged_by_user_id_users_id_fk" FOREIGN KEY ("merged_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_profile_merges" ADD CONSTRAINT "guest_profile_merges_merged_fk" FOREIGN KEY ("merged_profile_id","organization_id") REFERENCES "public"."guest_profiles"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_profile_merges" ADD CONSTRAINT "guest_profile_merges_kept_fk" FOREIGN KEY ("kept_profile_id","organization_id") REFERENCES "public"."guest_profiles"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_profile_number_counters" ADD CONSTRAINT "guest_profile_number_counters_org_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_profiles" ADD CONSTRAINT "guest_profiles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_profiles" ADD CONSTRAINT "guest_profiles_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_profiles" ADD CONSTRAINT "guest_profiles_merged_into_fk" FOREIGN KEY ("merged_into_profile_id","organization_id") REFERENCES "public"."guest_profiles"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_allergies" ADD CONSTRAINT "order_allergies_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_allergies" ADD CONSTRAINT "order_allergies_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_allergies" ADD CONSTRAINT "order_allergies_allergen_org_fk" FOREIGN KEY ("allergen_id","organization_id") REFERENCES "public"."allergens"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_allergens" ADD CONSTRAINT "order_item_allergens_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_allergens" ADD CONSTRAINT "order_item_allergens_allergen_id_allergens_id_fk" FOREIGN KEY ("allergen_id") REFERENCES "public"."allergens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "guest_profiles_org_phone_idx" ON "guest_profiles" USING btree ("organization_id","phone_normalized");--> statement-breakpoint
CREATE INDEX "guest_profiles_org_email_idx" ON "guest_profiles" USING btree ("organization_id","email_normalized");--> statement-breakpoint
ALTER TABLE "guest_parties" ADD CONSTRAINT "guest_parties_guest_profile_id_guest_profiles_id_fk" FOREIGN KEY ("guest_profile_id") REFERENCES "public"."guest_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_allergy_acknowledged_by_user_id_users_id_fk" FOREIGN KEY ("allergy_acknowledged_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "guest_parties_guest_profile_id_idx" ON "guest_parties" USING btree ("guest_profile_id");--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_category_valid" CHECK ("audit_events"."category" IN ('ACCESS', 'SECURITY', 'HR', 'SCHEDULING', 'ORDERS', 'MENU', 'INVENTORY', 'SETTLEMENTS', 'REPORTING', 'SYSTEM', 'ORGANIZATION', 'GUESTS'));--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_allergy_snapshot_fields" CHECK (("order_items"."allergy_acknowledged_at" IS NULL) = ("order_items"."allergy_acknowledged_by_user_id" IS NULL)
        AND ("order_items"."allergy_acknowledged_at" IS NULL) = ("order_items"."allergy_conflict_snapshot" IS NULL)
        AND ("order_items"."allergy_acknowledged_at" IS NULL OR "order_items"."allergen_label_incomplete_snapshot" IS NOT NULL)
        AND ("order_items"."status" <> 'DRAFT' OR ("order_items"."allergen_label_incomplete_snapshot" IS NULL AND "order_items"."allergy_acknowledged_at" IS NULL)));