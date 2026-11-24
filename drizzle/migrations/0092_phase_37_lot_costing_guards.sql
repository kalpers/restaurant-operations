-- Custom migration: Phase 37 lot costing guards (policies 3 and 7).

-- Each change of costing method is a record: never changed, never deleted.
CREATE FUNCTION "inventory_costing_changes_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Costing method changes are append-only'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'inventory_costing_changes_append_only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "inventory_costing_changes_append_only"
  BEFORE UPDATE OR DELETE ON "inventory_costing_changes"
  FOR EACH ROW EXECUTE FUNCTION "inventory_costing_changes_append_only"();
--> statement-breakpoint

-- The transfer line guard (0057) also freezes the exact value sent, written at send with
-- the unit cost.
CREATE OR REPLACE FUNCTION "inventory_transfer_lines_guard"() RETURNS trigger AS $$
DECLARE
  transfer_status text;
BEGIN
  SELECT "status" INTO transfer_status FROM "inventory_transfers"
    WHERE "id" = COALESCE(NEW."transfer_id", OLD."transfer_id");

  IF TG_OP = 'INSERT' OR TG_OP = 'DELETE' THEN
    IF transfer_status <> 'DRAFT' THEN
      RAISE EXCEPTION 'Lines change only while the transfer is a draft'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'inventory_transfer_lines_draft_only';
    END IF;

    RETURN COALESCE(NEW, OLD);
  END IF;

  IF NEW."id" <> OLD."id" OR NEW."transfer_id" <> OLD."transfer_id" OR NEW."created_at" <> OLD."created_at" THEN
    RAISE EXCEPTION 'A transfer line''s identity cannot change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'inventory_transfer_lines_identity_frozen';
  END IF;

  IF transfer_status = 'DRAFT' THEN
    IF NEW."base_quantity_received" IS NOT NULL THEN
      RAISE EXCEPTION 'A draft line has nothing received'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'inventory_transfer_lines_draft_unreceived';
    END IF;

    RETURN NEW;
  END IF;

  -- Sending sets the frozen cost in the same transaction that moves the transfer to SENT
  -- (the status update runs after the lines), so it is allowed while still DRAFT above; after
  -- that only the received quantity may change, once, while SENT.
  IF NEW."inventory_item_id" <> OLD."inventory_item_id"
     OR NEW."quantity" <> OLD."quantity"
     OR NEW."unit_of_measure_id" <> OLD."unit_of_measure_id"
     OR NEW."base_quantity" <> OLD."base_quantity"
     OR NEW."unit_cost_sent" IS DISTINCT FROM OLD."unit_cost_sent"
     OR NEW."value_sent" IS DISTINCT FROM OLD."value_sent" THEN
    RAISE EXCEPTION 'A sent line''s quantity and cost cannot change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'inventory_transfer_lines_sent_frozen';
  END IF;

  IF NEW."base_quantity_received" IS DISTINCT FROM OLD."base_quantity_received"
     AND (transfer_status <> 'SENT' OR OLD."base_quantity_received" IS NOT NULL) THEN
    RAISE EXCEPTION 'A line is received once, while its transfer is sent'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'inventory_transfer_lines_received_once';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
