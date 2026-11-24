-- Custom migration: Phase 36 event guards (policy 7, policy 3).

-- Events are cancelled, never deleted. A completed or cancelled event is frozen; the one change
-- it can take is a guest erase's text change (name, notes, menu notes, deposit reference, cancel reason),
-- accepted only with its `free_text_redactions` record written in the same transaction.
CREATE FUNCTION "event_bookings_guard"() RETURNS trigger AS $$
DECLARE
  frozen_keys text[] := ARRAY['name', 'notes', 'menu_notes', 'deposit_reference', 'cancel_reason', 'updated_at', 'updated_by_user_id', 'version'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Events are cancelled, never deleted'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'event_bookings_no_delete';
  END IF;

  IF NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
    OR NEW."location_id" IS DISTINCT FROM OLD."location_id"
    OR NEW."guest_party_id" IS DISTINCT FROM OLD."guest_party_id"
    OR NEW."event_number" IS DISTINCT FROM OLD."event_number"
    OR NEW."created_by_user_id" IS DISTINCT FROM OLD."created_by_user_id"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'An event keeps its number, party and location'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'event_bookings_identity_fixed';
  END IF;

  IF OLD."status" IN ('COMPLETED', 'CANCELLED') THEN
    IF (to_jsonb(NEW) - frozen_keys) IS DISTINCT FROM (to_jsonb(OLD) - frozen_keys)
      OR (NEW."name" IS DISTINCT FROM OLD."name" AND NOT "free_text_redaction_recorded"('event_bookings', OLD."id", 'name'))
      OR (NEW."notes" IS DISTINCT FROM OLD."notes" AND NOT "free_text_redaction_recorded"('event_bookings', OLD."id", 'notes'))
      OR (NEW."menu_notes" IS DISTINCT FROM OLD."menu_notes" AND NOT "free_text_redaction_recorded"('event_bookings', OLD."id", 'menu_notes'))
      OR (NEW."deposit_reference" IS DISTINCT FROM OLD."deposit_reference"
        AND NOT "free_text_redaction_recorded"('event_bookings', OLD."id", 'deposit_reference'))
      OR (NEW."cancel_reason" IS DISTINCT FROM OLD."cancel_reason"
        AND NOT "free_text_redaction_recorded"('event_bookings', OLD."id", 'cancel_reason')) THEN
      RAISE EXCEPTION 'A completed or cancelled event is frozen'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'event_bookings_finished_frozen';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "event_bookings_guard_trigger"
  BEFORE UPDATE OR DELETE ON "event_bookings"
  FOR EACH ROW EXECUTE FUNCTION "event_bookings_guard"();
