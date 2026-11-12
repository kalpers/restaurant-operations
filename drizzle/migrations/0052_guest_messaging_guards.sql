-- Custom migration: Phase 22 guest messaging guards (policies 2 and 4).

-- Policy 2: a guest message is never deleted. Its identity never changes; its address, subject
-- and body may only be cleared (erase, retention); and its status moves only forward:
--   QUEUED -> SENDING, SUPPRESSED, CANCELLED
--   SENDING -> SENT, FAILED, QUEUED (retry or crash recovery), SUPPRESSED, CANCELLED
--   FAILED -> QUEUED (resend)
--   SENT, SUPPRESSED and CANCELLED are final.
CREATE FUNCTION "guest_messages_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A guest message cannot be deleted'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'guest_messages_no_delete';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" NOT IN ('QUEUED', 'SUPPRESSED', 'CANCELLED') OR NEW."attempts" <> 0 THEN
      RAISE EXCEPTION 'A guest message starts QUEUED with no attempts'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'guest_messages_starts_queued';
    END IF;

    RETURN NEW;
  END IF;

  IF NEW."id" <> OLD."id"
     OR NEW."organization_id" <> OLD."organization_id"
     OR NEW."location_id" <> OLD."location_id"
     OR NEW."guest_party_id" <> OLD."guest_party_id"
     OR NEW."reservation_id" IS DISTINCT FROM OLD."reservation_id"
     OR NEW."waitlist_entry_id" IS DISTINCT FROM OLD."waitlist_entry_id"
     OR NEW."kind" <> OLD."kind"
     OR NEW."channel" <> OLD."channel"
     OR NEW."dedupe_key" <> OLD."dedupe_key"
     OR NEW."created_at" <> OLD."created_at" THEN
    RAISE EXCEPTION 'A guest message''s identity cannot change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'guest_messages_identity_frozen';
  END IF;

  IF (NEW."recipient_address" IS DISTINCT FROM OLD."recipient_address" AND NEW."recipient_address" IS NOT NULL)
     OR (NEW."subject" IS DISTINCT FROM OLD."subject" AND NEW."subject" IS NOT NULL)
     OR (NEW."body" IS DISTINCT FROM OLD."body" AND NEW."body" IS NOT NULL)
     OR (NEW."unsubscribe_token_hash" IS DISTINCT FROM OLD."unsubscribe_token_hash"
         AND NEW."unsubscribe_token_hash" IS NOT NULL)
     OR (OLD."erased_at" IS NOT NULL AND NEW."erased_at" IS DISTINCT FROM OLD."erased_at") THEN
    RAISE EXCEPTION 'A guest message''s content can only be cleared'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'guest_messages_content_frozen';
  END IF;

  IF NEW."status" <> OLD."status" AND NOT (
       (OLD."status" = 'QUEUED' AND NEW."status" IN ('SENDING', 'SUPPRESSED', 'CANCELLED'))
    OR (OLD."status" = 'SENDING' AND NEW."status" IN ('SENT', 'FAILED', 'QUEUED', 'SUPPRESSED', 'CANCELLED'))
    OR (OLD."status" = 'FAILED' AND NEW."status" = 'QUEUED')
  ) THEN
    RAISE EXCEPTION 'A guest message cannot move from % to %', OLD."status", NEW."status"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'guest_messages_status_transition';
  END IF;

  IF OLD."status" IN ('SENT', 'SUPPRESSED', 'CANCELLED') AND (
       NEW."attempts" <> OLD."attempts"
    OR NEW."provider_message_id" IS DISTINCT FROM OLD."provider_message_id"
    OR NEW."sent_at" IS DISTINCT FROM OLD."sent_at"
    OR NEW."suppressed_at" IS DISTINCT FROM OLD."suppressed_at"
    OR NEW."cancelled_at" IS DISTINCT FROM OLD."cancelled_at"
  ) THEN
    RAISE EXCEPTION 'A % guest message is final', OLD."status"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'guest_messages_final';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "guest_messages_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "guest_messages"
  FOR EACH ROW EXECUTE FUNCTION "guest_messages_guard"();
--> statement-breakpoint

-- Policy 4: the opt-out list is append-only.
CREATE FUNCTION "message_suppressions_guard"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'A message suppression cannot be changed or deleted'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'message_suppressions_append_only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "message_suppressions_guard"
  BEFORE UPDATE OR DELETE ON "message_suppressions"
  FOR EACH ROW EXECUTE FUNCTION "message_suppressions_guard"();
