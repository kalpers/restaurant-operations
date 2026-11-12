-- Custom migration: Phase 20 shared items (policy 17, D16).

-- Shares are records: never deleted, and an ACTIVE share changes only by being voided, once.
CREATE FUNCTION "order_item_shares_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'An item share cannot be deleted'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'order_item_shares_no_delete';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'ACTIVE' THEN
      RAISE EXCEPTION 'An item share starts ACTIVE'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'order_item_shares_starts_active';
    END IF;

    RETURN NEW;
  END IF;

  IF OLD."status" = 'VOIDED' THEN
    RAISE EXCEPTION 'A voided item share cannot change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'order_item_shares_frozen';
  END IF;

  IF NEW."id" <> OLD."id"
     OR NEW."organization_id" <> OLD."organization_id"
     OR NEW."order_item_id" <> OLD."order_item_id"
     OR NEW."order_id" <> OLD."order_id"
     OR NEW."split_group_id" <> OLD."split_group_id"
     OR NEW."share_number" <> OLD."share_number"
     OR NEW."share_count" <> OLD."share_count"
     OR NEW."amount" <> OLD."amount"
     OR NEW."tax_category_id" IS DISTINCT FROM OLD."tax_category_id"
     OR NEW."tax_category_code_snapshot" IS DISTINCT FROM OLD."tax_category_code_snapshot"
     OR NEW."tax_rate_snapshot" IS DISTINCT FROM OLD."tax_rate_snapshot"
     OR NEW."tax_included_snapshot" <> OLD."tax_included_snapshot"
     OR NEW."created_by_user_id" <> OLD."created_by_user_id"
     OR NEW."created_at" <> OLD."created_at" THEN
    RAISE EXCEPTION 'An item share''s facts cannot change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'order_item_shares_frozen';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "order_item_shares_guard_trigger"
  BEFORE INSERT OR UPDATE OR DELETE ON "order_item_shares"
  FOR EACH ROW EXECUTE FUNCTION "order_item_shares_guard"();
--> statement-breakpoint

-- A CLOSED order's shares are frozen with it: a share on a closed check can't be voided.
CREATE FUNCTION "order_item_shares_order_open"() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "orders" WHERE "id" = NEW."order_id" AND "status" <> 'OPEN') THEN
    RAISE EXCEPTION 'Shares change only on an OPEN check'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'order_item_shares_order_open';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "order_item_shares_order_open_trigger"
  BEFORE INSERT OR UPDATE ON "order_item_shares"
  FOR EACH ROW EXECUTE FUNCTION "order_item_shares_order_open"();
--> statement-breakpoint

-- The item freeze: SPLIT is terminal like VOIDED.
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
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'A sent order item''s snapshot cannot be changed'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'order_items_frozen';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
