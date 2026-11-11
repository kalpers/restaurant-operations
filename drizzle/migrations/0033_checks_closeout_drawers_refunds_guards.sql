-- Custom migration: Phase 17 cash drawers and refunds (policies B9-B11, E28-E33).

-- Policy E30: locations that existed before Phase 17 don't start requiring a drawer. The
-- column default stays true, so a location created from now on (including the foundation
-- seed on a fresh database, which runs after migrations) requires one.
UPDATE "location_settings" SET "cash_drawer_required" = false;
--> statement-breakpoint

-- Drawer movements and refund item links are append-only.
CREATE TRIGGER "cash_drawer_movements_append_only_trigger"
  BEFORE UPDATE OR DELETE ON "cash_drawer_movements"
  FOR EACH ROW EXECUTE FUNCTION "refuse_history_change"();
--> statement-breakpoint

CREATE TRIGGER "order_refund_items_append_only_trigger"
  BEFORE UPDATE OR DELETE ON "order_refund_items"
  FOR EACH ROW EXECUTE FUNCTION "refuse_history_change"();
--> statement-breakpoint

-- A drawer session is never deleted. It starts OPEN; CLOSED is terminal; its drawer,
-- location, number, business date, float and opening facts never change.
CREATE FUNCTION "cash_drawer_sessions_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A drawer session cannot be deleted'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'cash_drawer_sessions_no_delete';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'OPEN' THEN
      RAISE EXCEPTION 'A drawer session starts OPEN'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'cash_drawer_sessions_starts_open';
    END IF;

    RETURN NEW;
  END IF;

  IF OLD."status" <> 'OPEN' THEN
    RAISE EXCEPTION 'A closed drawer session cannot change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'cash_drawer_sessions_closed';
  END IF;

  IF (to_jsonb(NEW) - 'status' - 'closed_by_user_id' - 'closed_at' - 'counted_amount' - 'expected_amount'
        - 'variance' - 'close_note' - 'version' - 'updated_at')
      IS DISTINCT FROM
     (to_jsonb(OLD) - 'status' - 'closed_by_user_id' - 'closed_at' - 'counted_amount' - 'expected_amount'
        - 'variance' - 'close_note' - 'version' - 'updated_at') THEN
    RAISE EXCEPTION 'A drawer session''s opening facts cannot change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'cash_drawer_sessions_frozen';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER "cash_drawer_sessions_guard_trigger"
  BEFORE INSERT OR UPDATE OR DELETE ON "cash_drawer_sessions"
  FOR EACH ROW EXECUTE FUNCTION "cash_drawer_sessions_guard"();
--> statement-breakpoint

-- Cash goes into, or out of, an OPEN drawer session at the same location. Recording or
-- voiding cash against a CLOSED session would change a count already taken.
CREATE FUNCTION "cash_drawer_session_open_guard"() RETURNS trigger AS $$
DECLARE
  session_status text;
  session_location uuid;
  row_location uuid;
BEGIN
  IF NEW."cash_drawer_session_id" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT "status", "location_id" INTO session_status, session_location
    FROM "cash_drawer_sessions" WHERE "id" = NEW."cash_drawer_session_id";

  IF TG_TABLE_NAME = 'settlement_tenders' THEN
    SELECT "location_id" INTO row_location FROM "order_settlements" WHERE "id" = NEW."settlement_id";
  ELSE
    row_location := NEW."location_id";
  END IF;

  IF session_status IS DISTINCT FROM 'OPEN' OR session_location IS DISTINCT FROM row_location THEN
    RAISE EXCEPTION 'Cash is recorded only into an open drawer session at this location'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'cash_drawer_session_open';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER "settlement_tenders_drawer_open_trigger"
  BEFORE INSERT OR UPDATE ON "settlement_tenders"
  FOR EACH ROW EXECUTE FUNCTION "cash_drawer_session_open_guard"();
--> statement-breakpoint

CREATE TRIGGER "order_refunds_drawer_open_trigger"
  BEFORE INSERT OR UPDATE ON "order_refunds"
  FOR EACH ROW EXECUTE FUNCTION "cash_drawer_session_open_guard"();
--> statement-breakpoint

CREATE FUNCTION "cash_drawer_movements_open_guard"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "cash_drawer_sessions" WHERE "id" = NEW."session_id" AND "status" = 'OPEN'
  ) THEN
    RAISE EXCEPTION 'Paid-ins and paid-outs are recorded only into an open drawer session'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'cash_drawer_session_open';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER "cash_drawer_movements_open_trigger"
  BEFORE INSERT ON "cash_drawer_movements"
  FOR EACH ROW EXECUTE FUNCTION "cash_drawer_movements_open_guard"();
--> statement-breakpoint

-- A refund is recorded only against a CLOSED order and that order's COMPLETED settlement,
-- at the order's location. It is never deleted, and its only change is RECORDED -> VOIDED
-- with its void fields.
CREATE FUNCTION "order_refunds_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A refund cannot be deleted'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'order_refunds_no_delete';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'RECORDED' THEN
      RAISE EXCEPTION 'A refund is recorded, not voided, when created'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'order_refunds_insert_status';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM "orders" o JOIN "order_settlements" s ON s."order_id" = o."id"
      WHERE o."id" = NEW."order_id" AND o."status" = 'CLOSED' AND o."location_id" = NEW."location_id"
        AND s."id" = NEW."settlement_id" AND s."status" = 'COMPLETED'
    ) THEN
      RAISE EXCEPTION 'A refund needs a closed order and its completed settlement'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'order_refunds_closed_order';
    END IF;

    RETURN NEW;
  END IF;

  IF OLD."status" <> 'RECORDED' OR NEW."status" <> 'VOIDED'
    OR (to_jsonb(NEW) - 'status' - 'voided_by_user_id' - 'voided_at' - 'void_reason' - 'version' - 'updated_at')
      IS DISTINCT FROM
       (to_jsonb(OLD) - 'status' - 'voided_by_user_id' - 'voided_at' - 'void_reason' - 'version' - 'updated_at') THEN
    RAISE EXCEPTION 'A refund can only be voided'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'order_refunds_frozen';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER "order_refunds_guard_trigger"
  BEFORE INSERT OR UPDATE OR DELETE ON "order_refunds"
  FOR EACH ROW EXECUTE FUNCTION "order_refunds_guard"();
