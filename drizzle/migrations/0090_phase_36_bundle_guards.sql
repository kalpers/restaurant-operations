-- Custom migration: Phase 36 bundle guards (policy 9).

-- The order_items freeze trigger (latest in 0079) gains the bundle columns; nothing else changes.
CREATE OR REPLACE FUNCTION "order_items_freeze"() RETURNS trigger AS $$
DECLARE
  moving boolean;
  splitting boolean;
  reseating boolean;
  redacting boolean;
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

  -- Phase 29 (policy 5, amendment 4): a sent or shared item may change seat on its own check;
  -- every snapshot below is still compared, so nothing else about it can change.
  reseating := OLD."status" IN ('SUBMITTED', 'SPLIT') AND NEW."status" = OLD."status"
    AND NEW."order_id" IS NOT DISTINCT FROM OLD."order_id"
    AND NEW."seat_number" IS DISTINCT FROM OLD."seat_number";

  -- Phase 34 (policy 13): a guest erase replaces words of the instructions with "[redacted]".
  redacting := NEW."status" = OLD."status"
    AND NEW."order_id" IS NOT DISTINCT FROM OLD."order_id"
    AND NEW."seat_number" IS NOT DISTINCT FROM OLD."seat_number"
    AND (NEW."special_instructions" IS DISTINCT FROM OLD."special_instructions"
      OR NEW."kitchen_instructions_snapshot" IS DISTINCT FROM OLD."kitchen_instructions_snapshot");

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

  IF (OLD."status" = 'VOIDED' AND NOT redacting)
    OR (OLD."status" = 'SPLIT' AND NOT reseating AND NOT redacting)
    OR (NOT moving AND NOT splitting AND NOT reseating AND NOT redacting AND NEW."status" <> 'VOIDED')
    OR (NOT moving AND NEW."order_id" IS DISTINCT FROM OLD."order_id")
    OR NEW."menu_item_id" IS DISTINCT FROM OLD."menu_item_id"
    OR NEW."quantity" IS DISTINCT FROM OLD."quantity"
    OR NEW."menu_item_code_snapshot" IS DISTINCT FROM OLD."menu_item_code_snapshot"
    OR NEW."menu_item_name_snapshot" IS DISTINCT FROM OLD."menu_item_name_snapshot"
    OR NEW."base_price_snapshot" IS DISTINCT FROM OLD."base_price_snapshot"
    OR NEW."modifier_total_snapshot" IS DISTINCT FROM OLD."modifier_total_snapshot"
    OR NEW."unit_price_snapshot" IS DISTINCT FROM OLD."unit_price_snapshot"
    OR NEW."line_total_snapshot" IS DISTINCT FROM OLD."line_total_snapshot"
    OR NOT "text_unchanged_or_redacted"(OLD."special_instructions", NEW."special_instructions",
      'order_items', NEW."id", 'special_instructions')
    OR NOT "text_unchanged_or_redacted"(OLD."kitchen_instructions_snapshot", NEW."kitchen_instructions_snapshot",
      'order_items', NEW."id", 'kitchen_instructions_snapshot')
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
    -- Phase 36 (policy 9): a bundle component's links and snapshots are frozen too.
    OR NEW."bundle_parent_order_item_id" IS DISTINCT FROM OLD."bundle_parent_order_item_id"
    OR NEW."bundle_slot_id" IS DISTINCT FROM OLD."bundle_slot_id"
    OR NEW."bundle_slot_name_snapshot" IS DISTINCT FROM OLD."bundle_slot_name_snapshot"
    OR NEW."bundle_name_snapshot" IS DISTINCT FROM OLD."bundle_name_snapshot"
    OR NEW."bundle_upcharge_snapshot" IS DISTINCT FROM OLD."bundle_upcharge_snapshot"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'A sent order item''s snapshot cannot be changed'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'order_items_frozen';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- A bundle component is on the same order as its bundle line, and the line is a BUNDLE item
-- that isn't itself a component. Deferred to commit, so a bundle and its components can move
-- between checks together in any order.
CREATE FUNCTION "order_items_bundle_integrity"() RETURNS trigger AS $$
DECLARE
  parent record;
BEGIN
  IF NEW."bundle_parent_order_item_id" IS NOT NULL THEN
    SELECT oi."order_id", oi."bundle_parent_order_item_id", mi."item_kind" INTO parent
    FROM "order_items" oi
    JOIN "menu_items" mi ON mi."id" = oi."menu_item_id"
    WHERE oi."id" = NEW."bundle_parent_order_item_id";

    IF parent."order_id" IS DISTINCT FROM NEW."order_id" OR parent."item_kind" <> 'BUNDLE' OR parent."bundle_parent_order_item_id" IS NOT NULL THEN
      RAISE EXCEPTION 'A bundle component stays on its bundle''s check'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'order_items_bundle_together';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM "order_items" child
    WHERE child."bundle_parent_order_item_id" = NEW."id" AND child."order_id" <> NEW."order_id"
  ) THEN
    RAISE EXCEPTION 'A bundle and its components stay on one check'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'order_items_bundle_together';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "order_items_bundle_integrity_trigger"
  AFTER INSERT OR UPDATE ON "order_items"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "order_items_bundle_integrity"();
--> statement-breakpoint

-- Slots and options are deactivated, never deleted.
CREATE FUNCTION "menu_bundle_config_no_delete"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Bundle slots and options are deactivated, never deleted'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'menu_bundle_config_no_delete';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "menu_item_bundle_slots_no_delete_trigger"
  BEFORE DELETE ON "menu_item_bundle_slots"
  FOR EACH ROW EXECUTE FUNCTION "menu_bundle_config_no_delete"();
--> statement-breakpoint
CREATE TRIGGER "menu_item_bundle_slot_options_no_delete_trigger"
  BEFORE DELETE ON "menu_item_bundle_slot_options"
  FOR EACH ROW EXECUTE FUNCTION "menu_bundle_config_no_delete"();
