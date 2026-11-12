CREATE TABLE "guest_party_message_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guest_party_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"address" text,
	"granted_at" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"granted_by_user_id" uuid,
	"withdrawn_at" timestamp with time zone,
	"withdrawn_by_user_id" uuid,
	"withdraw_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guest_party_message_consents_channel_valid" CHECK ("guest_party_message_consents"."channel" IN ('EMAIL', 'SMS')),
	CONSTRAINT "guest_party_message_consents_source_valid" CHECK ("guest_party_message_consents"."source" IN ('ONLINE_FORM', 'STAFF_RECORDED')),
	CONSTRAINT "guest_party_message_consents_granted_by" CHECK (("guest_party_message_consents"."source" = 'STAFF_RECORDED') = ("guest_party_message_consents"."granted_by_user_id" IS NOT NULL)),
	CONSTRAINT "guest_party_message_consents_withdrawn_metadata" CHECK (("guest_party_message_consents"."withdrawn_at" IS NULL) = ("guest_party_message_consents"."withdraw_reason" IS NULL)
        AND ("guest_party_message_consents"."withdrawn_by_user_id" IS NULL OR "guest_party_message_consents"."withdrawn_at" IS NOT NULL)),
	CONSTRAINT "guest_party_message_consents_withdraw_reason_valid" CHECK ("guest_party_message_consents"."withdraw_reason" IS NULL OR "guest_party_message_consents"."withdraw_reason" IN ('STAFF', 'ADDRESS_CHANGED', 'UNSUBSCRIBED', 'PROVIDER_OPT_OUT', 'ERASED')),
	CONSTRAINT "guest_party_message_consents_address" CHECK (("guest_party_message_consents"."address" IS NOT NULL OR "guest_party_message_consents"."withdrawn_at" IS NOT NULL)
        AND ("guest_party_message_consents"."address" IS NULL OR ("guest_party_message_consents"."channel" = 'SMS' AND "guest_party_message_consents"."address" ~ '^[+][1-9][0-9]{6,14}$')
          OR ("guest_party_message_consents"."channel" = 'EMAIL' AND length("guest_party_message_consents"."address") <= 254)))
);
--> statement-breakpoint
CREATE TABLE "reservation_manage_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reservation_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "reservation_manage_links_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "reservation_manage_links_token_hash_format" CHECK ("reservation_manage_links"."token_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_category_valid";--> statement-breakpoint
ALTER TABLE "guest_party_message_consents" ADD CONSTRAINT "message_consents_guest_party_fk" FOREIGN KEY ("guest_party_id") REFERENCES "public"."guest_parties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_party_message_consents" ADD CONSTRAINT "message_consents_granted_by_user_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_party_message_consents" ADD CONSTRAINT "message_consents_withdrawn_by_user_fk" FOREIGN KEY ("withdrawn_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_manage_links" ADD CONSTRAINT "reservation_manage_links_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "guest_party_message_consents_one_active" ON "guest_party_message_consents" USING btree ("guest_party_id","channel") WHERE "guest_party_message_consents"."withdrawn_at" IS NULL;--> statement-breakpoint
CREATE INDEX "reservation_manage_links_reservation_id_idx" ON "reservation_manage_links" USING btree ("reservation_id");--> statement-breakpoint
CREATE INDEX "reservation_manage_links_expires_at_idx" ON "reservation_manage_links" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_category_valid" CHECK ("audit_events"."category" IN ('ACCESS', 'SECURITY', 'HR', 'SCHEDULING', 'ORDERS', 'MENU', 'INVENTORY', 'SETTLEMENTS', 'REPORTING', 'SYSTEM', 'ORGANIZATION', 'GUESTS', 'MESSAGING'));