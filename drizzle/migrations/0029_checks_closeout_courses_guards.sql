-- Custom migration: Phase 17 courses and hold/fire (policies D21-D26).
--
-- Tickets were append-only (0016). Firing a held ticket is now the one change a ticket
-- allows: `fired_at` and `fired_by_user_id` go from NULL to set, once. Every other column
-- stays frozen and tickets are still never deleted.

DROP TRIGGER "kitchen_tickets_append_only_trigger" ON "kitchen_tickets";
--> statement-breakpoint

CREATE FUNCTION "kitchen_tickets_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A kitchen ticket cannot be deleted'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'kitchen_tickets_append_only';
  END IF;

  IF OLD."fired_at" IS NOT NULL
    OR NEW."fired_at" IS NULL
    OR (to_jsonb(NEW) - 'fired_at' - 'fired_by_user_id') IS DISTINCT FROM (to_jsonb(OLD) - 'fired_at' - 'fired_by_user_id') THEN
    RAISE EXCEPTION 'A kitchen ticket can only be fired'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'kitchen_tickets_append_only';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- Existing tickets were all sent to the kitchen at once: fired when submitted. This runs
-- before the guard trigger exists, so it is the only bulk change ever made to tickets.
UPDATE "kitchen_tickets" SET "fired_at" = "submitted_at" WHERE "fired_at" IS NULL;
--> statement-breakpoint

CREATE TRIGGER "kitchen_tickets_guard_trigger"
  BEFORE UPDATE OR DELETE ON "kitchen_tickets"
  FOR EACH ROW EXECUTE FUNCTION "kitchen_tickets_guard"();
--> statement-breakpoint

-- A ticket is either held (held_at set, fired later) or fired at creation; only a held
-- ticket is fired by someone; a remake is never held; courses are 1 to 5.
ALTER TABLE "kitchen_tickets"
  ADD CONSTRAINT "kitchen_tickets_fire_fields" CHECK (
    "course_number" BETWEEN 1 AND 5
    AND ("held_at" IS NOT NULL OR "fired_at" IS NOT NULL)
    AND ("fired_by_user_id" IS NULL OR ("held_at" IS NOT NULL AND "fired_at" IS NOT NULL))
    AND ("fired_at" IS NULL OR "held_at" IS NULL OR "fired_at" >= "held_at")
    AND ("remake_id" IS NULL OR "held_at" IS NULL)
  );
--> statement-breakpoint

-- Station work on a held (unfired) ticket stays NEW: it can be cancelled by a void, but
-- not started, readied or completed until its course is fired.
CREATE OR REPLACE FUNCTION "kitchen_ticket_items_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A kitchen ticket item cannot be deleted'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'kitchen_ticket_items_frozen';
  END IF;

  IF NEW."ticket_id" IS DISTINCT FROM OLD."ticket_id"
    OR NEW."location_id" IS DISTINCT FROM OLD."location_id"
    OR NEW."prep_station_id" IS DISTINCT FROM OLD."prep_station_id"
    OR NEW."order_id" IS DISTINCT FROM OLD."order_id"
    OR NEW."order_item_id" IS DISTINCT FROM OLD."order_item_id"
    OR NEW."attempt_number" IS DISTINCT FROM OLD."attempt_number"
    OR NEW."quantity" IS DISTINCT FROM OLD."quantity"
    OR NEW."menu_item_code_snapshot" IS DISTINCT FROM OLD."menu_item_code_snapshot"
    OR NEW."menu_item_name_snapshot" IS DISTINCT FROM OLD."menu_item_name_snapshot"
    OR NEW."modifier_snapshots" IS DISTINCT FROM OLD."modifier_snapshots"
    OR NEW."kitchen_instructions_snapshot" IS DISTINCT FROM OLD."kitchen_instructions_snapshot"
    OR NEW."submitted_at" IS DISTINCT FROM OLD."submitted_at"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'A kitchen ticket item''s snapshot cannot be changed'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'kitchen_ticket_items_frozen';
  END IF;

  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
    (OLD."status" = 'NEW' AND NEW."status" IN ('PREPARING', 'CANCELLED'))
    OR (OLD."status" = 'PREPARING' AND NEW."status" IN ('READY', 'CANCELLED'))
    OR (OLD."status" = 'READY' AND NEW."status" IN ('COMPLETED', 'CANCELLED'))
  ) THEN
    RAISE EXCEPTION 'Kitchen ticket item cannot move from % to %', OLD."status", NEW."status"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'kitchen_ticket_items_transition';
  END IF;

  IF OLD."status" IN ('COMPLETED', 'CANCELLED') THEN
    RAISE EXCEPTION 'A % kitchen ticket item cannot change', OLD."status"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'kitchen_ticket_items_transition';
  END IF;

  IF NEW."status" IS DISTINCT FROM OLD."status" AND NEW."status" <> 'CANCELLED' AND EXISTS (
    SELECT 1 FROM "kitchen_tickets" WHERE "id" = NEW."ticket_id" AND "fired_at" IS NULL
  ) THEN
    RAISE EXCEPTION 'This course is held; fire it before starting it'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'kitchen_ticket_items_held';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
