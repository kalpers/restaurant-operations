-- Custom migration: Phase 17 tax guards (policies A1-A7). Replaces three functions from
-- 0014 and 0020 rather than editing those migrations, and adds the tax rate overlap rule.

-- A Tax Category has at most one rate in force per Location at any instant. Half-open.
ALTER TABLE "tax_rates"
  ADD CONSTRAINT "tax_rates_no_overlap"
  EXCLUDE USING gist (
    "tax_category_id" WITH =,
    "location_id" WITH =,
    tstzrange("effective_from", "effective_to", '[)') WITH &&
  );
--> statement-breakpoint

-- Once an item leaves DRAFT its snapshot is immutable, now including its course and tax
-- snapshot. A SUBMITTED item may only become VOIDED; a VOIDED item never changes; neither
-- is deleted.
CREATE OR REPLACE FUNCTION "order_items_freeze"() RETURNS trigger AS $$
BEGIN
  IF OLD."status" = 'DRAFT' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A sent or voided order item cannot be deleted'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'order_items_frozen';
  END IF;

  IF OLD."status" = 'VOIDED'
    OR NEW."status" <> 'VOIDED'
    OR NEW."order_id" IS DISTINCT FROM OLD."order_id"
    OR NEW."menu_item_id" IS DISTINCT FROM OLD."menu_item_id"
    OR NEW."quantity" IS DISTINCT FROM OLD."quantity"
    OR NEW."menu_item_code_snapshot" IS DISTINCT FROM OLD."menu_item_code_snapshot"
    OR NEW."menu_item_name_snapshot" IS DISTINCT FROM OLD."menu_item_name_snapshot"
    OR NEW."base_price_snapshot" IS DISTINCT FROM OLD."base_price_snapshot"
    OR NEW."modifier_total_snapshot" IS DISTINCT FROM OLD."modifier_total_snapshot"
    OR NEW."unit_price_snapshot" IS DISTINCT FROM OLD."unit_price_snapshot"
    OR NEW."line_total_snapshot" IS DISTINCT FROM OLD."line_total_snapshot"
    OR NEW."special_instructions" IS DISTINCT FROM OLD."special_instructions"
    OR NEW."kitchen_instructions_snapshot" IS DISTINCT FROM OLD."kitchen_instructions_snapshot"
    OR NEW."prep_station_ids_snapshot" IS DISTINCT FROM OLD."prep_station_ids_snapshot"
    OR NEW."recipe_id" IS DISTINCT FROM OLD."recipe_id"
    OR NEW."recipe_version_id" IS DISTINCT FROM OLD."recipe_version_id"
    OR NEW."send_batch_id" IS DISTINCT FROM OLD."send_batch_id"
    OR NEW."added_by_user_id" IS DISTINCT FROM OLD."added_by_user_id"
    OR NEW."submitted_at" IS DISTINCT FROM OLD."submitted_at"
    OR NEW."course_number" IS DISTINCT FROM OLD."course_number"
    OR NEW."tax_category_id" IS DISTINCT FROM OLD."tax_category_id"
    OR NEW."tax_category_code_snapshot" IS DISTINCT FROM OLD."tax_category_code_snapshot"
    OR NEW."tax_rate_snapshot" IS DISTINCT FROM OLD."tax_rate_snapshot"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'A sent order item''s snapshot cannot be changed'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'order_items_frozen';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- Orders and settlements, with tax:
--   * OPEN -> CLOSED needs a COMPLETED settlement for the amount due (subtotal + tax).
--     `total_due` is a generated column, which isn't computed yet in a BEFORE trigger, so
--     the sum is spelled out.
--   * CLOSED is terminal: a closed order never changes.
--   * While a settlement is OPEN, the order's amount (including tax) and status are locked.
CREATE OR REPLACE FUNCTION "orders_settlement_guard"() RETURNS trigger AS $$
BEGIN
  IF OLD."status" = 'CLOSED' THEN
    RAISE EXCEPTION 'A closed order cannot change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'orders_closed_frozen';
  END IF;

  IF NEW."status" = 'CLOSED' THEN
    IF NOT EXISTS (
      SELECT 1 FROM "order_settlements"
      WHERE "order_id" = NEW."id" AND "status" = 'COMPLETED'
        AND "order_amount_snapshot" = NEW."subtotal" + NEW."tax_total"
    ) THEN
      RAISE EXCEPTION 'An order closes only through a completed settlement'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'orders_close_requires_settlement';
    END IF;

    RETURN NEW;
  END IF;

  IF (NEW."status" IS DISTINCT FROM OLD."status"
      OR NEW."item_subtotal" IS DISTINCT FROM OLD."item_subtotal"
      OR NEW."discount_total" IS DISTINCT FROM OLD."discount_total"
      OR NEW."subtotal" IS DISTINCT FROM OLD."subtotal"
      OR NEW."tax_total" IS DISTINCT FROM OLD."tax_total")
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

-- A Settlement belongs to its Order's Location, is never deleted, keeps its identity and
-- amount snapshot (now including the tax part), and is frozen once COMPLETED or CANCELLED.
CREATE OR REPLACE FUNCTION "order_settlements_guard"() RETURNS trigger AS $$
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
    OR NEW."tax_total_snapshot" IS DISTINCT FROM OLD."tax_total_snapshot"
    OR NEW."opened_by_user_id" IS DISTINCT FROM OLD."opened_by_user_id"
    OR NEW."opened_at" IS DISTINCT FROM OLD."opened_at"
    OR NEW."opened_business_date" IS DISTINCT FROM OLD."opened_business_date" THEN
    RAISE EXCEPTION 'A settlement''s order and amount snapshot cannot change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'order_settlements_snapshot_frozen';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
