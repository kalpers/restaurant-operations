-- Custom migration: Kitchen fulfillment rules Drizzle's schema language can't express.

-- Tickets, item history, Remakes and Remake consumption are append-only.
-- `refuse_history_change` comes from 0012.
CREATE TRIGGER "kitchen_tickets_append_only_trigger"
  BEFORE UPDATE OR DELETE ON "kitchen_tickets"
  FOR EACH ROW EXECUTE FUNCTION "refuse_history_change"();
--> statement-breakpoint

CREATE TRIGGER "kitchen_ticket_item_status_history_append_only_trigger"
  BEFORE UPDATE OR DELETE ON "kitchen_ticket_item_status_history"
  FOR EACH ROW EXECUTE FUNCTION "refuse_history_change"();
--> statement-breakpoint

CREATE TRIGGER "kitchen_remakes_append_only_trigger"
  BEFORE UPDATE OR DELETE ON "kitchen_remakes"
  FOR EACH ROW EXECUTE FUNCTION "refuse_history_change"();
--> statement-breakpoint

CREATE TRIGGER "kitchen_remake_consumption_append_only_trigger"
  BEFORE UPDATE OR DELETE ON "kitchen_remake_consumption"
  FOR EACH ROW EXECUTE FUNCTION "refuse_history_change"();
--> statement-breakpoint

-- A work item's snapshot never changes and the row is never deleted. Its status moves only
-- along NEW -> PREPARING -> READY -> COMPLETED, or to CANCELLED from NEW, PREPARING or
-- READY. COMPLETED and CANCELLED are terminal: there is no recall or reopen.
CREATE FUNCTION "kitchen_ticket_items_guard"() RETURNS trigger AS $$
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

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER "kitchen_ticket_items_guard_trigger"
  BEFORE UPDATE OR DELETE ON "kitchen_ticket_items"
  FOR EACH ROW EXECUTE FUNCTION "kitchen_ticket_items_guard"();
--> statement-breakpoint

-- A notification is never deleted; only `read_at` may change, and only once.
CREATE FUNCTION "notifications_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A notification cannot be deleted'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'notifications_frozen';
  END IF;

  IF OLD."read_at" IS NOT NULL
    OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
    OR NEW."location_id" IS DISTINCT FROM OLD."location_id"
    OR NEW."recipient_user_id" IS DISTINCT FROM OLD."recipient_user_id"
    OR NEW."notification_type" IS DISTINCT FROM OLD."notification_type"
    OR NEW."title" IS DISTINCT FROM OLD."title"
    OR NEW."body" IS DISTINCT FROM OLD."body"
    OR NEW."order_id" IS DISTINCT FROM OLD."order_id"
    OR NEW."kitchen_ticket_id" IS DISTINCT FROM OLD."kitchen_ticket_id"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'A notification can only be marked read'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'notifications_frozen';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER "notifications_guard_trigger"
  BEFORE UPDATE OR DELETE ON "notifications"
  FOR EACH ROW EXECUTE FUNCTION "notifications_guard"();
--> statement-breakpoint

-- An outbox row's event never changes; only its publishing state does. Rows are not
-- deleted by the application (retention is an operational task).
CREATE FUNCTION "outbox_events_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'An outbox event cannot be deleted'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'outbox_events_frozen';
  END IF;

  IF NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
    OR NEW."location_id" IS DISTINCT FROM OLD."location_id"
    OR NEW."event_type" IS DISTINCT FROM OLD."event_type"
    OR NEW."aggregate_type" IS DISTINCT FROM OLD."aggregate_type"
    OR NEW."aggregate_id" IS DISTINCT FROM OLD."aggregate_id"
    OR NEW."recipient_user_id" IS DISTINCT FROM OLD."recipient_user_id"
    OR NEW."payload" IS DISTINCT FROM OLD."payload"
    OR NEW."occurred_at" IS DISTINCT FROM OLD."occurred_at"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'An outbox event cannot be changed'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'outbox_events_frozen';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER "outbox_events_guard_trigger"
  BEFORE UPDATE OR DELETE ON "outbox_events"
  FOR EACH ROW EXECUTE FUNCTION "outbox_events_guard"();
