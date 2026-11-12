-- Custom migration: Phase 20 notifications (policies 11-14). A notification can still only be
-- marked read; its new links and dedupe key are frozen with everything else.
CREATE OR REPLACE FUNCTION "notifications_guard"() RETURNS trigger AS $$
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
    OR NEW."inventory_stock_alert_id" IS DISTINCT FROM OLD."inventory_stock_alert_id"
    OR NEW."schedule_period_id" IS DISTINCT FROM OLD."schedule_period_id"
    OR NEW."shift_swap_request_id" IS DISTINCT FROM OLD."shift_swap_request_id"
    OR NEW."time_off_request_id" IS DISTINCT FROM OLD."time_off_request_id"
    OR NEW."employee_certification_id" IS DISTINCT FROM OLD."employee_certification_id"
    OR NEW."time_entry_id" IS DISTINCT FROM OLD."time_entry_id"
    OR NEW."dedupe_key" IS DISTINCT FROM OLD."dedupe_key"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'A notification can only be marked read'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'notifications_frozen';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
