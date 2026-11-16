-- Custom migration: Phase 25 purchasing forecast snapshot guards (policy 14, D7).

-- A purchasing forecast is stored as it was when drafts were created from it, and never
-- changes afterwards.
CREATE FUNCTION "purchasing_forecasts_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Stored purchasing forecasts are append-only'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'purchasing_forecasts_append_only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "purchasing_forecasts_append_only_trigger"
  BEFORE UPDATE OR DELETE ON "purchasing_forecasts"
  FOR EACH ROW EXECUTE FUNCTION "purchasing_forecasts_append_only"();
--> statement-breakpoint
CREATE TRIGGER "purchasing_forecast_items_append_only_trigger"
  BEFORE UPDATE OR DELETE ON "purchasing_forecast_items"
  FOR EACH ROW EXECUTE FUNCTION "purchasing_forecasts_append_only"();
--> statement-breakpoint
CREATE TRIGGER "purchasing_forecast_lines_append_only_trigger"
  BEFORE UPDATE OR DELETE ON "purchasing_forecast_lines"
  FOR EACH ROW EXECUTE FUNCTION "purchasing_forecasts_append_only"();
