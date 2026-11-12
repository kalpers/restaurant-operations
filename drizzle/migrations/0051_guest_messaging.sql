CREATE TABLE "guest_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"guest_party_id" uuid NOT NULL,
	"reservation_id" uuid,
	"waitlist_entry_id" uuid,
	"kind" text NOT NULL,
	"channel" text NOT NULL,
	"recipient_address" text,
	"subject" text,
	"body" text,
	"unsubscribe_token_hash" text,
	"dedupe_key" text NOT NULL,
	"status" text DEFAULT 'QUEUED' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"send_after" timestamp with time zone DEFAULT now() NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"last_error_code" text,
	"provider_message_id" text,
	"sent_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"suppressed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"erased_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guest_messages_dedupe_key_unique" UNIQUE("dedupe_key"),
	CONSTRAINT "guest_messages_kind_valid" CHECK ("guest_messages"."kind" IN ('RESERVATION_CONFIRMED', 'RESERVATION_RECEIVED', 'RESERVATION_CHANGED', 'RESERVATION_CANCELLED', 'RESERVATION_REMINDER', 'WAITLIST_TABLE_READY')),
	CONSTRAINT "guest_messages_channel_valid" CHECK ("guest_messages"."channel" IN ('EMAIL', 'SMS')),
	CONSTRAINT "guest_messages_status_valid" CHECK ("guest_messages"."status" IN ('QUEUED', 'SENDING', 'SENT', 'FAILED', 'SUPPRESSED', 'CANCELLED')),
	CONSTRAINT "guest_messages_one_subject" CHECK (num_nonnulls("guest_messages"."reservation_id", "guest_messages"."waitlist_entry_id") = 1),
	CONSTRAINT "guest_messages_kind_matches_subject" CHECK (("guest_messages"."kind" = 'WAITLIST_TABLE_READY') = ("guest_messages"."waitlist_entry_id" IS NOT NULL)),
	CONSTRAINT "guest_messages_subject_line_email_only" CHECK ("guest_messages"."channel" = 'EMAIL' OR ("guest_messages"."subject" IS NULL AND "guest_messages"."unsubscribe_token_hash" IS NULL)),
	CONSTRAINT "guest_messages_content" CHECK (CASE WHEN "guest_messages"."erased_at" IS NULL
        THEN "guest_messages"."recipient_address" IS NOT NULL AND "guest_messages"."body" IS NOT NULL
        ELSE "guest_messages"."recipient_address" IS NULL AND "guest_messages"."subject" IS NULL AND "guest_messages"."body" IS NULL END),
	CONSTRAINT "guest_messages_not_sendable_when_erased" CHECK ("guest_messages"."erased_at" IS NULL OR "guest_messages"."status" NOT IN ('QUEUED', 'SENDING')),
	CONSTRAINT "guest_messages_attempts_non_negative" CHECK ("guest_messages"."attempts" >= 0),
	CONSTRAINT "guest_messages_sending_claimed" CHECK (("guest_messages"."status" = 'SENDING') = ("guest_messages"."claimed_at" IS NOT NULL)),
	CONSTRAINT "guest_messages_sent_metadata" CHECK (("guest_messages"."status" = 'SENT') = ("guest_messages"."sent_at" IS NOT NULL)),
	CONSTRAINT "guest_messages_failed_metadata" CHECK (("guest_messages"."status" = 'FAILED') = ("guest_messages"."failed_at" IS NOT NULL)),
	CONSTRAINT "guest_messages_suppressed_metadata" CHECK (("guest_messages"."status" = 'SUPPRESSED') = ("guest_messages"."suppressed_at" IS NOT NULL)),
	CONSTRAINT "guest_messages_cancelled_metadata" CHECK (("guest_messages"."status" = 'CANCELLED') = ("guest_messages"."cancelled_at" IS NOT NULL)),
	CONSTRAINT "guest_messages_error_code_valid" CHECK ("guest_messages"."last_error_code" IS NULL OR "guest_messages"."last_error_code" ~ '^[A-Za-z0-9_.:-]{1,60}$')
);
--> statement-breakpoint
CREATE TABLE "message_suppressions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"address_hash" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_suppressions_org_channel_hash_unique" UNIQUE("organization_id","channel","address_hash"),
	CONSTRAINT "message_suppressions_channel_valid" CHECK ("message_suppressions"."channel" IN ('EMAIL', 'SMS')),
	CONSTRAINT "message_suppressions_reason_valid" CHECK ("message_suppressions"."reason" IN ('UNSUBSCRIBED', 'PROVIDER_OPT_OUT', 'STAFF')),
	CONSTRAINT "message_suppressions_hash_format" CHECK ("message_suppressions"."address_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "guest_messages" ADD CONSTRAINT "guest_messages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_messages" ADD CONSTRAINT "guest_messages_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_messages" ADD CONSTRAINT "guest_messages_guest_party_id_guest_parties_id_fk" FOREIGN KEY ("guest_party_id") REFERENCES "public"."guest_parties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_messages" ADD CONSTRAINT "guest_messages_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_messages" ADD CONSTRAINT "guest_messages_waitlist_entry_id_waitlist_entries_id_fk" FOREIGN KEY ("waitlist_entry_id") REFERENCES "public"."waitlist_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_suppressions" ADD CONSTRAINT "message_suppressions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "guest_messages_due_idx" ON "guest_messages" USING btree ("send_after","next_attempt_at") WHERE "guest_messages"."status" = 'QUEUED';--> statement-breakpoint
CREATE INDEX "guest_messages_sending_idx" ON "guest_messages" USING btree ("claimed_at") WHERE "guest_messages"."status" = 'SENDING';--> statement-breakpoint
CREATE INDEX "guest_messages_failed_idx" ON "guest_messages" USING btree ("organization_id","failed_at") WHERE "guest_messages"."status" = 'FAILED';--> statement-breakpoint
CREATE INDEX "guest_messages_retention_idx" ON "guest_messages" USING btree ("created_at") WHERE "guest_messages"."erased_at" IS NULL;--> statement-breakpoint
CREATE INDEX "guest_messages_reservation_id_idx" ON "guest_messages" USING btree ("reservation_id");--> statement-breakpoint
CREATE INDEX "guest_messages_waitlist_entry_id_idx" ON "guest_messages" USING btree ("waitlist_entry_id");--> statement-breakpoint
CREATE INDEX "guest_messages_guest_party_id_idx" ON "guest_messages" USING btree ("guest_party_id");--> statement-breakpoint
CREATE INDEX "guest_messages_unsubscribe_token_hash_idx" ON "guest_messages" USING btree ("unsubscribe_token_hash") WHERE "guest_messages"."unsubscribe_token_hash" IS NOT NULL;