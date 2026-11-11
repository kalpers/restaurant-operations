-- Custom migration: Phase 18 time clock and tip pools (policies A2, A3, A8, A9, D25).
-- btree_gist comes from 0003. refuse_history_change() comes from 0012.

-- Policy A2: one employee can't be on two non-voided entries at once. An OPEN entry runs to
-- infinity, so nothing can be entered after it until it is closed.
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_no_overlap"
  EXCLUDE USING gist (
    "employee_id" WITH =,
    tstzrange("clock_in_at", COALESCE("clock_out_at", 'infinity'::timestamptz), '[)') WITH &&
  ) WHERE ("status" <> 'VOIDED');
--> statement-breakpoint

-- Policies A2, A8, A9: an entry is never deleted and starts OPEN with the punch instant as its
-- effective clock-in. The original punch facts never change. A recorded clock-out, once
-- written, never changes. A CLOSED entry doesn't reopen, and a VOIDED entry is terminal.
CREATE FUNCTION "time_entries_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A time entry cannot be deleted'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'time_entries_no_delete';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'OPEN' OR NEW."clock_in_at" <> NEW."clock_in_recorded_at" THEN
      RAISE EXCEPTION 'A time entry starts OPEN at its punch instant'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'time_entries_starts_open';
    END IF;

    RETURN NEW;
  END IF;

  IF OLD."status" = 'VOIDED' THEN
    RAISE EXCEPTION 'A voided time entry cannot change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'time_entries_voided';
  END IF;

  IF OLD."status" = 'CLOSED' AND NEW."status" = 'OPEN' THEN
    RAISE EXCEPTION 'A closed time entry cannot reopen'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'time_entries_no_reopen';
  END IF;

  IF OLD."clock_out_recorded_at" IS NOT NULL
     AND NEW."clock_out_recorded_at" IS DISTINCT FROM OLD."clock_out_recorded_at" THEN
    RAISE EXCEPTION 'A recorded clock-out cannot change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'time_entries_recorded_frozen';
  END IF;

  IF NEW."id" <> OLD."id"
     OR NEW."organization_id" <> OLD."organization_id"
     OR NEW."location_id" <> OLD."location_id"
     OR NEW."employee_id" <> OLD."employee_id"
     OR NEW."clock_in_recorded_at" <> OLD."clock_in_recorded_at"
     OR NEW."clock_in_source" <> OLD."clock_in_source"
     OR NEW."clock_in_by_user_id" <> OLD."clock_in_by_user_id"
     OR NEW."clock_in_idempotency_record_id" <> OLD."clock_in_idempotency_record_id"
     OR NEW."created_at" <> OLD."created_at" THEN
    RAISE EXCEPTION 'A time entry''s punch facts cannot change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'time_entries_recorded_frozen';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER "time_entries_guard_trigger"
  BEFORE INSERT OR UPDATE OR DELETE ON "time_entries"
  FOR EACH ROW EXECUTE FUNCTION "time_entries_guard"();
--> statement-breakpoint

-- Policy A3: a break lies inside its entry. Checked at commit, from both sides, so an
-- adjustment can move the entry and its breaks in one transaction.
CREATE FUNCTION "time_entry_breaks_within_entry"(entry_id uuid) RETURNS void AS $$
DECLARE
  entry_row record;
BEGIN
  SELECT "status", "clock_in_at", "clock_out_at" INTO entry_row FROM "time_entries" WHERE "id" = entry_id;

  IF NOT FOUND OR entry_row."status" = 'VOIDED' THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM "time_entry_breaks" b
    WHERE b."time_entry_id" = entry_id
      AND b."removed_at" IS NULL
      AND (
        b."started_at" < entry_row."clock_in_at"
        OR (entry_row."clock_out_at" IS NOT NULL
            AND (b."ended_at" IS NULL OR b."ended_at" > entry_row."clock_out_at"))
      )
  ) THEN
    RAISE EXCEPTION 'A break must lie inside its time entry'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'time_entry_breaks_within_entry';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "time_entry_breaks" a
    JOIN "time_entry_breaks" b ON b."time_entry_id" = a."time_entry_id" AND b."id" < a."id"
    WHERE a."time_entry_id" = entry_id
      AND a."removed_at" IS NULL AND b."removed_at" IS NULL
      AND tstzrange(a."started_at", COALESCE(a."ended_at", 'infinity'::timestamptz), '[)')
          && tstzrange(b."started_at", COALESCE(b."ended_at", 'infinity'::timestamptz), '[)')
  ) THEN
    RAISE EXCEPTION 'Breaks in one time entry cannot overlap'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'time_entry_breaks_no_overlap';
  END IF;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE FUNCTION "time_entry_breaks_check"() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'time_entries' THEN
    PERFORM "time_entry_breaks_within_entry"(NEW."id");
  ELSE
    PERFORM "time_entry_breaks_within_entry"(NEW."time_entry_id");
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER "time_entry_breaks_check_trigger"
  AFTER INSERT OR UPDATE ON "time_entry_breaks"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "time_entry_breaks_check"();
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER "time_entries_breaks_check_trigger"
  AFTER UPDATE ON "time_entries"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "time_entry_breaks_check"();
--> statement-breakpoint

-- A break is never deleted (removal sets removed_at), its entry never changes, and a removed
-- break stays removed.
CREATE FUNCTION "time_entry_breaks_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A break cannot be deleted'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'time_entry_breaks_no_delete';
  END IF;

  IF NEW."time_entry_id" <> OLD."time_entry_id" OR OLD."removed_at" IS NOT NULL THEN
    RAISE EXCEPTION 'A removed break, or a break''s entry, cannot change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'time_entry_breaks_frozen';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER "time_entry_breaks_guard_trigger"
  BEFORE UPDATE OR DELETE ON "time_entry_breaks"
  FOR EACH ROW EXECUTE FUNCTION "time_entry_breaks_guard"();
--> statement-breakpoint

-- Policy A8: adjustment history is append-only.
CREATE TRIGGER "time_entry_adjustments_append_only_trigger"
  BEFORE UPDATE OR DELETE ON "time_entry_adjustments"
  FOR EACH ROW EXECUTE FUNCTION "refuse_history_change"();
--> statement-breakpoint

-- Policy D25: distribution lines are append-only. A distribution is never deleted, starts
-- FINALIZED, and its only change is FINALIZED -> VOIDED with the void fields.
CREATE TRIGGER "tip_distribution_lines_append_only_trigger"
  BEFORE UPDATE OR DELETE ON "tip_distribution_lines"
  FOR EACH ROW EXECUTE FUNCTION "refuse_history_change"();
--> statement-breakpoint

CREATE FUNCTION "tip_distributions_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A tip distribution cannot be deleted'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'tip_distributions_no_delete';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'FINALIZED' THEN
      RAISE EXCEPTION 'A tip distribution starts FINALIZED'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'tip_distributions_starts_finalized';
    END IF;

    RETURN NEW;
  END IF;

  IF OLD."status" <> 'FINALIZED' OR NEW."status" <> 'VOIDED'
     OR (to_jsonb(NEW) - 'status' - 'voided_by_user_id' - 'voided_at' - 'void_reason' - 'version' - 'updated_at')
        IS DISTINCT FROM
        (to_jsonb(OLD) - 'status' - 'voided_by_user_id' - 'voided_at' - 'void_reason' - 'version' - 'updated_at') THEN
    RAISE EXCEPTION 'A tip distribution can only be voided'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'tip_distributions_frozen';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER "tip_distributions_guard_trigger"
  BEFORE INSERT OR UPDATE OR DELETE ON "tip_distributions"
  FOR EACH ROW EXECUTE FUNCTION "tip_distributions_guard"();
