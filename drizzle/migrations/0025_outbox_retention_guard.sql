-- Phase 16 retention (policy 15). An outbox row's event still never changes; only its
-- publishing state does (published, attempts, backoff, dead letter). The maintenance runner
-- may now delete a row once it has been published. Unpublished and dead-lettered rows are
-- never deleted.
CREATE OR REPLACE FUNCTION "outbox_events_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."published_at" IS NULL OR OLD."failed_at" IS NOT NULL THEN
      RAISE EXCEPTION 'Only a published outbox event can be deleted'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'outbox_events_frozen';
    END IF;

    RETURN OLD;
  END IF;

  IF NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
    OR NEW."location_id" IS DISTINCT FROM OLD."location_id"
    OR NEW."event_type" IS DISTINCT FROM OLD."event_type"
    OR NEW."aggregate_type" IS DISTINCT FROM OLD."aggregate_type"
    OR NEW."aggregate_id" IS DISTINCT FROM OLD."aggregate_id"
    OR NEW."recipient_user_id" IS DISTINCT FROM OLD."recipient_user_id"
    OR NEW."payload" IS DISTINCT FROM OLD."payload"
    OR NEW."occurred_at" IS DISTINCT FROM OLD."occurred_at"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'An outbox event cannot be changed'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'outbox_events_frozen';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
