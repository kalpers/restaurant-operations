-- Custom migration: Order history rules Drizzle's schema language can't express.

-- Domain history is append-only. `refuse_history_change` comes from 0012.
CREATE TRIGGER "order_status_history_append_only_trigger"
  BEFORE UPDATE OR DELETE ON "order_status_history"
  FOR EACH ROW EXECUTE FUNCTION "refuse_history_change"();
--> statement-breakpoint

CREATE TRIGGER "order_item_status_history_append_only_trigger"
  BEFORE UPDATE OR DELETE ON "order_item_status_history"
  FOR EACH ROW EXECUTE FUNCTION "refuse_history_change"();
--> statement-breakpoint

CREATE TRIGGER "order_send_batches_append_only_trigger"
  BEFORE UPDATE OR DELETE ON "order_send_batches"
  FOR EACH ROW EXECUTE FUNCTION "refuse_history_change"();
--> statement-breakpoint

CREATE TRIGGER "order_item_inventory_consumption_append_only_trigger"
  BEFORE UPDATE OR DELETE ON "order_item_inventory_consumption"
  FOR EACH ROW EXECUTE FUNCTION "refuse_history_change"();
--> statement-breakpoint

CREATE TRIGGER "order_item_voids_append_only_trigger"
  BEFORE UPDATE OR DELETE ON "order_item_voids"
  FOR EACH ROW EXECUTE FUNCTION "refuse_history_change"();
--> statement-breakpoint

-- Once an item leaves DRAFT its snapshot is immutable. A SUBMITTED item may only become
-- VOIDED (recording who, when and why); a VOIDED item never changes; neither is deleted.
CREATE FUNCTION "order_items_freeze"() RETURNS trigger AS $$
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
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'A sent order item''s snapshot cannot be changed'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'order_items_frozen';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER "order_items_freeze_trigger"
  BEFORE UPDATE OR DELETE ON "order_items"
  FOR EACH ROW EXECUTE FUNCTION "order_items_freeze"();
--> statement-breakpoint

-- Modifier selections change only while their item is a draft.
CREATE FUNCTION "order_item_modifiers_freeze"() RETURNS trigger AS $$
DECLARE
  item_status text;
BEGIN
  SELECT "status" INTO item_status FROM "order_items"
    WHERE "id" = COALESCE(NEW."order_item_id", OLD."order_item_id");

  IF item_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'Modifiers of a sent order item cannot be changed'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'order_item_modifiers_frozen';
  END IF;

  IF TG_OP = 'UPDATE' AND NEW."order_item_id" IS DISTINCT FROM OLD."order_item_id" THEN
    RAISE EXCEPTION 'A modifier selection cannot move to another item'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'order_item_modifiers_frozen';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER "order_item_modifiers_freeze_trigger"
  BEFORE INSERT OR UPDATE OR DELETE ON "order_item_modifiers"
  FOR EACH ROW EXECUTE FUNCTION "order_item_modifiers_freeze"();
--> statement-breakpoint

-- A Table Session can't end (COMPLETED or CANCELLED) while any of its orders is OPEN.
-- Order creation locks the session FOR SHARE, so this check, made under the session's
-- update, can't miss an order being opened at the same moment.
CREATE FUNCTION "table_sessions_no_open_orders"() RETURNS trigger AS $$
BEGIN
  IF OLD."status" = 'ACTIVE' AND NEW."status" <> 'ACTIVE' AND EXISTS (
    SELECT 1 FROM "orders" WHERE "table_session_id" = NEW."id" AND "status" = 'OPEN'
  ) THEN
    RAISE EXCEPTION 'A table session with an open order cannot end'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'table_sessions_orders_open';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER "table_sessions_no_open_orders_trigger"
  BEFORE UPDATE OF "status" ON "table_sessions"
  FOR EACH ROW EXECUTE FUNCTION "table_sessions_no_open_orders"();
