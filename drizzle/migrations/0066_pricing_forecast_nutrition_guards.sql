-- Custom migration: Phase 28 guards (amendment 1).

-- Policy 2: price periods are deactivated, never deleted (sent items reference them).
CREATE FUNCTION "price_periods_no_delete"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'A price period is deactivated, never deleted'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'price_periods_no_delete';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "price_periods_no_delete_trigger"
  BEFORE DELETE ON "price_periods"
  FOR EACH ROW EXECUTE FUNCTION "price_periods_no_delete"();
--> statement-breakpoint

-- Policy 4: the price-period snapshots are frozen with the item's other snapshots.
-- The rest of the function is unchanged from 0050.
CREATE OR REPLACE FUNCTION "order_items_freeze"() RETURNS trigger AS $$
DECLARE
  moving boolean;
  splitting boolean;
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

  -- Phase 20 (policy 17): SUBMITTED -> SPLIT only alongside share rows written in this
  -- transaction; nothing else about the item changes.
  splitting := OLD."status" = 'SUBMITTED' AND NEW."status" = 'SPLIT';

  IF splitting AND NOT EXISTS (
    SELECT 1 FROM "order_item_shares"
    WHERE "order_item_id" = NEW."id" AND "created_at" = now()
  ) THEN
    RAISE EXCEPTION 'A sent order item is split only into recorded shares'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'order_items_frozen';
  END IF;

  IF moving AND NOT EXISTS (
    SELECT 1 FROM "order_item_transfers"
    WHERE "order_item_id" = NEW."id" AND "from_order_id" = OLD."order_id"
      AND "to_order_id" = NEW."order_id" AND "moved_at" = now()
  ) THEN
    RAISE EXCEPTION 'A sent order item moves to another order only through a recorded transfer'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'order_items_frozen';
  END IF;

  IF OLD."status" IN ('VOIDED', 'SPLIT')
    OR (NOT moving AND NOT splitting AND NEW."status" <> 'VOIDED')
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
    OR NEW."allergen_label_incomplete_snapshot" IS DISTINCT FROM OLD."allergen_label_incomplete_snapshot"
    OR NEW."allergy_acknowledged_by_user_id" IS DISTINCT FROM OLD."allergy_acknowledged_by_user_id"
    OR NEW."allergy_acknowledged_at" IS DISTINCT FROM OLD."allergy_acknowledged_at"
    OR NEW."allergy_conflict_snapshot" IS DISTINCT FROM OLD."allergy_conflict_snapshot"
    OR NEW."price_period_id" IS DISTINCT FROM OLD."price_period_id"
    OR NEW."price_period_name_snapshot" IS DISTINCT FROM OLD."price_period_name_snapshot"
    OR NEW."regular_price_snapshot" IS DISTINCT FROM OLD."regular_price_snapshot"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'A sent order item''s snapshot cannot be changed'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'order_items_frozen';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
