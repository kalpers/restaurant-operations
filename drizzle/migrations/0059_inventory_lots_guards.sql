-- Custom migration: Phase 23 lot guards (policies 16, 17 and 21).

-- Lot movements are append-only, like the ledger they belong to.
CREATE FUNCTION "inventory_lot_movements_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Lot movements are append-only'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'inventory_lot_movements_append_only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "inventory_lot_movements_append_only"
  BEFORE UPDATE OR DELETE ON "inventory_lot_movements"
  FOR EACH ROW EXECUTE FUNCTION "inventory_lot_movements_append_only"();
--> statement-breakpoint

-- A ledger row's lot movements sum to its quantity. Checked at commit, once all of the
-- row's movements (including settlement pairs) are written.
CREATE FUNCTION "inventory_lot_movements_balance"() RETURNS trigger AS $$
DECLARE
  ledger_delta numeric;
  movement_sum numeric;
BEGIN
  SELECT "base_quantity_delta" INTO ledger_delta FROM "inventory_transactions"
    WHERE "id" = NEW."inventory_transaction_id";
  SELECT COALESCE(SUM("base_quantity_delta"), 0) INTO movement_sum FROM "inventory_lot_movements"
    WHERE "inventory_transaction_id" = NEW."inventory_transaction_id";

  IF movement_sum <> ledger_delta THEN
    RAISE EXCEPTION 'Lot movements (%) do not match the ledger row (%)', movement_sum, ledger_delta
      USING ERRCODE = 'check_violation', CONSTRAINT = 'inventory_lot_movements_match_ledger';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "inventory_lot_movements_balance"
  AFTER INSERT ON "inventory_lot_movements"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "inventory_lot_movements_balance"();
--> statement-breakpoint

-- A lot is never deleted. What it is (item, location, number, origin, source, cost,
-- received quantity and date) never changes; only its remaining quantity (through postings)
-- and a corrected supplier code or expiry date may.
CREATE FUNCTION "inventory_lots_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A lot cannot be deleted'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'inventory_lots_no_delete';
  END IF;

  IF NEW."id" <> OLD."id"
     OR NEW."organization_id" <> OLD."organization_id"
     OR NEW."location_id" <> OLD."location_id"
     OR NEW."inventory_item_id" <> OLD."inventory_item_id"
     OR NEW."sequence_number" <> OLD."sequence_number"
     OR NEW."lot_number" <> OLD."lot_number"
     OR NEW."origin" <> OLD."origin"
     OR NEW."source_lot_id" IS DISTINCT FROM OLD."source_lot_id"
     OR NEW."unit_cost" IS DISTINCT FROM OLD."unit_cost"
     OR NEW."quantity_received" <> OLD."quantity_received"
     OR NEW."received_on" <> OLD."received_on"
     OR NEW."created_at" <> OLD."created_at" THEN
    RAISE EXCEPTION 'A lot''s identity cannot change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'inventory_lots_identity_frozen';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "inventory_lots_guard"
  BEFORE UPDATE OR DELETE ON "inventory_lots"
  FOR EACH ROW EXECUTE FUNCTION "inventory_lots_guard"();
