-- Custom migration: Phase 24 forecast snapshot guards (policy 11, D6).

-- A forecast is stored as it was when a manager used it, and never changes afterwards.
CREATE FUNCTION "demand_forecasts_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Stored demand forecasts are append-only'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'demand_forecasts_append_only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "demand_forecasts_append_only_trigger"
  BEFORE UPDATE OR DELETE ON "demand_forecasts"
  FOR EACH ROW EXECUTE FUNCTION "demand_forecasts_append_only"();
--> statement-breakpoint
CREATE TRIGGER "demand_forecast_dates_append_only_trigger"
  BEFORE UPDATE OR DELETE ON "demand_forecast_dates"
  FOR EACH ROW EXECUTE FUNCTION "demand_forecasts_append_only"();
--> statement-breakpoint
CREATE TRIGGER "demand_forecast_hours_append_only_trigger"
  BEFORE UPDATE OR DELETE ON "demand_forecast_hours"
  FOR EACH ROW EXECUTE FUNCTION "demand_forecasts_append_only"();
