-- Custom migration: Phase 20 tax (policies 15 and 16).

-- The settlement guard: tax inside prices and the exemption are part of the amount, so they
-- can't change while a settlement is OPEN, and a CLOSED order still can't change at all.
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
      OR NEW."tax_total" IS DISTINCT FROM OLD."tax_total"
      OR NEW."included_tax_total" IS DISTINCT FROM OLD."included_tax_total"
      OR NEW."tax_exempt" IS DISTINCT FROM OLD."tax_exempt")
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

-- Policy 15: "price includes tax" is frozen at SEND with the rest of the tax snapshot.
CREATE OR REPLACE FUNCTION "order_items_freeze"() RETURNS trigger AS $$
DECLARE
  moving boolean;
BEGIN
  IF OLD."status" = 'DRAFT' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A sent or voided order item cannot be deleted'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'order_items_frozen';
  END IF;

  moving := OLD."status" = 'SUBMITTED' AND NEW."status" = 'SUBMITTED'
    AND NEW."order_id" IS DISTINCT FROM OLD."order_id";

  IF moving AND NOT EXISTS (
    SELECT 1 FROM "order_item_transfers"
    WHERE "order_item_id" = NEW."id" AND "from_order_id" = OLD."order_id"
      AND "to_order_id" = NEW."order_id" AND "moved_at" = now()
  ) THEN
    RAISE EXCEPTION 'A sent order item moves to another order only through a recorded transfer'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'order_items_frozen';
  END IF;

  IF OLD."status" = 'VOIDED'
    OR (NOT moving AND NEW."status" <> 'VOIDED')
    OR (NOT moving AND NEW."order_id" IS DISTINCT FROM OLD."order_id")
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
    OR NEW."tax_included_snapshot" IS DISTINCT FROM OLD."tax_included_snapshot"
    OR NEW."menu_category_id" IS DISTINCT FROM OLD."menu_category_id"
    OR NEW."menu_category_name_snapshot" IS DISTINCT FROM OLD."menu_category_name_snapshot"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'A sent order item''s snapshot cannot be changed'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'order_items_frozen';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
