-- Custom migration: a prep station can't be deactivated while it still has unfinished
-- Kitchen/Bar work (NEW, PREPARING or READY), whichever service or path tries. Renaming
-- and other edits are unaffected; submitted tickets keep their own station snapshot.
CREATE FUNCTION "prep_stations_active_work_guard"() RETURNS trigger AS $$
BEGIN
  IF OLD."active" AND NOT NEW."active" AND EXISTS (
    SELECT 1 FROM "kitchen_ticket_items"
    WHERE "prep_station_id" = OLD."id" AND "status" IN ('NEW', 'PREPARING', 'READY')
  ) THEN
    RAISE EXCEPTION 'Prep station % still has unfinished work', OLD."code"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'prep_stations_active_work';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER "prep_stations_active_work_trigger"
  BEFORE UPDATE OF "active" ON "prep_stations"
  FOR EACH ROW EXECUTE FUNCTION "prep_stations_active_work_guard"();
