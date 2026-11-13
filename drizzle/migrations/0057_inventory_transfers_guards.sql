-- Custom migration: Phase 23 transfer guards (policy 10).

-- A transfer is never deleted, its two locations and number never change, and its status
-- moves only forward:
--   DRAFT -> SENT, CANCELLED
--   SENT -> RECEIVED
--   RECEIVED and CANCELLED are final.
CREATE FUNCTION "inventory_transfers_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A transfer cannot be deleted'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'inventory_transfers_no_delete';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'A transfer starts as a DRAFT'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'inventory_transfers_starts_draft';
    END IF;

    RETURN NEW;
  END IF;

  IF NEW."id" <> OLD."id"
     OR NEW."organization_id" <> OLD."organization_id"
     OR NEW."from_location_id" <> OLD."from_location_id"
     OR NEW."to_location_id" <> OLD."to_location_id"
     OR NEW."sequence_number" <> OLD."sequence_number"
     OR NEW."transfer_number" <> OLD."transfer_number"
     OR NEW."created_by_user_id" <> OLD."created_by_user_id"
     OR NEW."created_at" <> OLD."created_at" THEN
    RAISE EXCEPTION 'A transfer''s identity cannot change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'inventory_transfers_identity_frozen';
  END IF;

  IF NEW."status" <> OLD."status" AND NOT (
       (OLD."status" = 'DRAFT' AND NEW."status" IN ('SENT', 'CANCELLED'))
       OR (OLD."status" = 'SENT' AND NEW."status" = 'RECEIVED')
     ) THEN
    RAISE EXCEPTION 'A transfer can''t move from % to %', OLD."status", NEW."status"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'inventory_transfers_status_forward';
  END IF;

  IF OLD."status" IN ('RECEIVED', 'CANCELLED') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'A received or cancelled transfer cannot change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'inventory_transfers_final';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "inventory_transfers_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "inventory_transfers"
  FOR EACH ROW EXECUTE FUNCTION "inventory_transfers_guard"();
--> statement-breakpoint

-- Lines are added, changed and removed only while their transfer is a DRAFT. Once sent,
-- only the received quantity may be set, once, while the transfer is SENT, and the frozen
-- cost is written only at send.
CREATE FUNCTION "inventory_transfer_lines_guard"() RETURNS trigger AS $$
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
     OR NEW."unit_cost_sent" IS DISTINCT FROM OLD."unit_cost_sent" THEN
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
--> statement-breakpoint
CREATE TRIGGER "inventory_transfer_lines_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "inventory_transfer_lines"
  FOR EACH ROW EXECUTE FUNCTION "inventory_transfer_lines_guard"();
