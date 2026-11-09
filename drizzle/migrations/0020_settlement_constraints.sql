-- Custom migration: Phase 11 settlement guards. These are the final integrity layer under
-- the Settlement services and the close-order workflow.

-- Settlement status history is append-only. `refuse_history_change` comes from 0012.
CREATE TRIGGER "settlement_status_history_append_only_trigger"
  BEFORE UPDATE OR DELETE ON "settlement_status_history"
  FOR EACH ROW EXECUTE FUNCTION "refuse_history_change"();
--> statement-breakpoint

-- A Settlement belongs to its Order's Location, is never deleted, keeps its identity and
-- amount snapshot, and is frozen once COMPLETED or CANCELLED.
CREATE FUNCTION "order_settlements_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A settlement cannot be deleted'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'order_settlements_no_delete';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM "orders" WHERE "id" = NEW."order_id" AND "location_id" = NEW."location_id"
    ) THEN
      RAISE EXCEPTION 'A settlement must be at its order''s location'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'order_settlements_order_location';
    END IF;

    IF NEW."status" <> 'OPEN' THEN
      RAISE EXCEPTION 'A settlement starts OPEN'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'order_settlements_starts_open';
    END IF;

    RETURN NEW;
  END IF;

  IF OLD."status" <> 'OPEN' THEN
    RAISE EXCEPTION 'A completed or cancelled settlement cannot change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'order_settlements_terminal';
  END IF;

  IF NEW."order_id" IS DISTINCT FROM OLD."order_id"
    OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
    OR NEW."location_id" IS DISTINCT FROM OLD."location_id"
    OR NEW."order_amount_snapshot" IS DISTINCT FROM OLD."order_amount_snapshot"
    OR NEW."opened_by_user_id" IS DISTINCT FROM OLD."opened_by_user_id"
    OR NEW."opened_at" IS DISTINCT FROM OLD."opened_at"
    OR NEW."opened_business_date" IS DISTINCT FROM OLD."opened_business_date" THEN
    RAISE EXCEPTION 'A settlement''s order and amount snapshot cannot change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'order_settlements_snapshot_frozen';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER "order_settlements_guard_trigger"
  BEFORE INSERT OR UPDATE OR DELETE ON "order_settlements"
  FOR EACH ROW EXECUTE FUNCTION "order_settlements_guard"();
--> statement-breakpoint

-- Tenders are never deleted. A new tender needs an OPEN settlement. The only change is a
-- RECORDED tender becoming VOIDED (with its void fields) while its settlement is OPEN.
CREATE FUNCTION "settlement_tenders_guard"() RETURNS trigger AS $$
DECLARE
  settlement_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A tender cannot be deleted'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'settlement_tenders_no_delete';
  END IF;

  SELECT "status" INTO settlement_status FROM "order_settlements" WHERE "id" = NEW."settlement_id";

  IF settlement_status IS DISTINCT FROM 'OPEN' THEN
    RAISE EXCEPTION 'Tenders change only while their settlement is OPEN'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'settlement_tenders_settlement_open';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" = 'VOIDED' THEN
      RAISE EXCEPTION 'A tender cannot be recorded as voided'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'settlement_tenders_insert_status';
    END IF;

    RETURN NEW;
  END IF;

  IF OLD."status" <> 'RECORDED' OR NEW."status" <> 'VOIDED'
    OR (to_jsonb(NEW) - 'status' - 'voided_by_user_id' - 'voided_at' - 'void_reason')
      IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'voided_by_user_id' - 'voided_at' - 'void_reason') THEN
    RAISE EXCEPTION 'A tender can only be voided'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'settlement_tenders_frozen';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER "settlement_tenders_guard_trigger"
  BEFORE INSERT OR UPDATE OR DELETE ON "settlement_tenders"
  FOR EACH ROW EXECUTE FUNCTION "settlement_tenders_guard"();
--> statement-breakpoint

-- Orders and settlements:
--   * OPEN -> CLOSED needs a COMPLETED settlement for the order (no close bypass).
--   * CLOSED is terminal: a closed order never changes.
--   * While a settlement is OPEN, the order's amount and status are locked, so the
--     settlement's snapshot can't go stale (SEND, voids and discounts are refused).
-- Settlement creation and every order mutation lock the order row first, so this check
-- can't miss a settlement being opened at the same moment.
CREATE FUNCTION "orders_settlement_guard"() RETURNS trigger AS $$
BEGIN
  IF OLD."status" = 'CLOSED' THEN
    RAISE EXCEPTION 'A closed order cannot change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'orders_closed_frozen';
  END IF;

  IF NEW."status" = 'CLOSED' THEN
    IF NOT EXISTS (
      SELECT 1 FROM "order_settlements"
      WHERE "order_id" = NEW."id" AND "status" = 'COMPLETED'
        AND "order_amount_snapshot" = NEW."subtotal"
    ) THEN
      RAISE EXCEPTION 'An order closes only through a completed settlement'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'orders_close_requires_settlement';
    END IF;

    RETURN NEW;
  END IF;

  IF (NEW."status" IS DISTINCT FROM OLD."status"
      OR NEW."item_subtotal" IS DISTINCT FROM OLD."item_subtotal"
      OR NEW."discount_total" IS DISTINCT FROM OLD."discount_total"
      OR NEW."subtotal" IS DISTINCT FROM OLD."subtotal")
    AND EXISTS (
      SELECT 1 FROM "order_settlements" WHERE "order_id" = NEW."id" AND "status" = 'OPEN'
    ) THEN
    RAISE EXCEPTION 'The order is being settled'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'orders_settlement_in_progress';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER "orders_settlement_guard_trigger"
  BEFORE UPDATE ON "orders"
  FOR EACH ROW EXECUTE FUNCTION "orders_settlement_guard"();
