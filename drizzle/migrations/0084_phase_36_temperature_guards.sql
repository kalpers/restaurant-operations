-- Custom migration: Phase 36 temperature log guards (policy 6, policy 3).

-- Check points are deactivated, never deleted.
CREATE FUNCTION "temperature_points_no_delete"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Temperature check points are deactivated, never deleted'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'temperature_points_no_delete';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "temperature_points_no_delete_trigger"
  BEFORE DELETE ON "temperature_points"
  FOR EACH ROW EXECUTE FUNCTION "temperature_points_no_delete"();
--> statement-breakpoint

-- Readings are append-only. A correction or follow-up names an earlier reading at the same
-- location. The one change ever made is a guest erase's recorded redaction of the corrective action.
CREATE FUNCTION "temperature_readings_guard"() RETURNS trigger AS $$
DECLARE
  linked record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Temperature readings are never deleted'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'temperature_readings_append_only';
  END IF;

  IF TG_OP = 'INSERT' THEN
    FOR linked IN
      SELECT "location_id", "taken_at" FROM "temperature_readings"
      WHERE "id" IN (NEW."corrects_reading_id", NEW."follows_up_reading_id")
    LOOP
      IF linked."location_id" <> NEW."location_id" OR linked."taken_at" > NEW."taken_at" THEN
        RAISE EXCEPTION 'A reading names only an earlier reading at its own location'
          USING ERRCODE = 'check_violation', CONSTRAINT = 'temperature_readings_link_valid';
      END IF;
    END LOOP;

    RETURN NEW;
  END IF;

  IF (to_jsonb(NEW) - 'corrective_action') IS DISTINCT FROM (to_jsonb(OLD) - 'corrective_action')
    OR NOT "text_unchanged_or_redacted"(OLD."corrective_action", NEW."corrective_action", 'temperature_readings', OLD."id", 'corrective_action') THEN
    RAISE EXCEPTION 'Temperature readings are append-only'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'temperature_readings_append_only';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "temperature_readings_guard_trigger"
  BEFORE INSERT OR UPDATE OR DELETE ON "temperature_readings"
  FOR EACH ROW EXECUTE FUNCTION "temperature_readings_guard"();
