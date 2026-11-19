-- Custom migration: Phase 32 manager log guards (policy 6).

-- The manager log is append-only. An entry is never deleted, and the only change ever made
-- to one is a single redaction: the body emptied and the three redaction fields set, with
-- the entry's number, place, date, category, author and correction link left as they were.
-- A new entry that corrects another must name an earlier entry at the same location.
CREATE FUNCTION "manager_log_entries_guard"() RETURNS trigger AS $$
DECLARE
  corrected_location uuid;
  corrected_created timestamptz;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A manager log entry cannot be deleted'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'manager_log_entries_append_only';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD."redacted_at" IS NOT NULL OR NEW."redacted_at" IS NULL
       OR NEW."id" <> OLD."id" OR NEW."organization_id" <> OLD."organization_id"
       OR NEW."location_id" <> OLD."location_id" OR NEW."entry_number" <> OLD."entry_number"
       OR NEW."business_date" <> OLD."business_date" OR NEW."category" <> OLD."category"
       OR NEW."author_user_id" <> OLD."author_user_id"
       OR NEW."author_employee_id" IS DISTINCT FROM OLD."author_employee_id"
       OR NEW."corrects_entry_id" IS DISTINCT FROM OLD."corrects_entry_id"
       OR NEW."created_at" <> OLD."created_at" THEN
      RAISE EXCEPTION 'A manager log entry can only be redacted, once'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'manager_log_entries_append_only';
    END IF;

    RETURN NEW;
  END IF;

  IF NEW."redacted_at" IS NOT NULL THEN
    RAISE EXCEPTION 'A manager log entry cannot be written already redacted'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'manager_log_entries_append_only';
  END IF;

  IF NEW."corrects_entry_id" IS NOT NULL THEN
    SELECT "location_id", "created_at" INTO corrected_location, corrected_created
    FROM "manager_log_entries"
    WHERE "id" = NEW."corrects_entry_id";

    IF corrected_location IS DISTINCT FROM NEW."location_id" OR corrected_created > NEW."created_at" THEN
      RAISE EXCEPTION 'A correction must name an earlier entry at the same location'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'manager_log_entries_correction_valid';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "manager_log_entries_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "manager_log_entries"
  FOR EACH ROW EXECUTE FUNCTION "manager_log_entries_guard"();
