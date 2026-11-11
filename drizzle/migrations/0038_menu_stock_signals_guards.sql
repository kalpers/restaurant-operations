-- Custom migration: Phase 19 menu and stock signals (policies A2, A5, 11).
-- Rows are records: none of these tables allows DELETE, and each allows only the one change
-- its lifecycle needs.

-- Policy A2: an outage starts ACTIVE and changes only by being restored, once.
CREATE FUNCTION "menu_item_outages_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'An 86 record cannot be deleted'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'menu_item_outages_no_delete';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'ACTIVE' THEN
      RAISE EXCEPTION 'An 86 record starts ACTIVE'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'menu_item_outages_starts_active';
    END IF;

    RETURN NEW;
  END IF;

  IF OLD."status" = 'RESTORED' THEN
    RAISE EXCEPTION 'A restored 86 record cannot change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'menu_item_outages_frozen';
  END IF;

  IF NEW."id" <> OLD."id"
     OR NEW."organization_id" <> OLD."organization_id"
     OR NEW."location_id" <> OLD."location_id"
     OR NEW."menu_item_id" <> OLD."menu_item_id"
     OR NEW."reason" <> OLD."reason"
     OR NEW."marked_out_at" <> OLD."marked_out_at"
     OR NEW."marked_out_by_user_id" <> OLD."marked_out_by_user_id"
     OR NEW."created_at" <> OLD."created_at" THEN
    RAISE EXCEPTION 'An 86 record''s facts cannot change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'menu_item_outages_frozen';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "menu_item_outages_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "menu_item_outages"
  FOR EACH ROW EXECUTE FUNCTION "menu_item_outages_guard"();
--> statement-breakpoint

-- Policy A5: an override starts uncleared and changes only by being cleared, once.
CREATE FUNCTION "menu_item_stock_overrides_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A sell-anyway record cannot be deleted'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'menu_item_stock_overrides_no_delete';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."cleared_at" IS NOT NULL THEN
      RAISE EXCEPTION 'A sell-anyway record starts uncleared'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'menu_item_stock_overrides_starts_open';
    END IF;

    RETURN NEW;
  END IF;

  IF OLD."cleared_at" IS NOT NULL THEN
    RAISE EXCEPTION 'A cleared sell-anyway record cannot change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'menu_item_stock_overrides_frozen';
  END IF;

  IF NEW."id" <> OLD."id"
     OR NEW."organization_id" <> OLD."organization_id"
     OR NEW."location_id" <> OLD."location_id"
     OR NEW."menu_item_id" <> OLD."menu_item_id"
     OR NEW."business_date" <> OLD."business_date"
     OR NEW."reason" <> OLD."reason"
     OR NEW."set_at" <> OLD."set_at"
     OR NEW."set_by_user_id" <> OLD."set_by_user_id"
     OR NEW."created_at" <> OLD."created_at" THEN
    RAISE EXCEPTION 'A sell-anyway record''s facts cannot change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'menu_item_stock_overrides_frozen';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "menu_item_stock_overrides_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "menu_item_stock_overrides"
  FOR EACH ROW EXECUTE FUNCTION "menu_item_stock_overrides_guard"();
--> statement-breakpoint

-- Policy 11: an alert starts OPEN and changes only by being resolved, once.
CREATE FUNCTION "inventory_stock_alerts_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A low-stock alert cannot be deleted'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'inventory_stock_alerts_no_delete';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'OPEN' THEN
      RAISE EXCEPTION 'A low-stock alert starts OPEN'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'inventory_stock_alerts_starts_open';
    END IF;

    RETURN NEW;
  END IF;

  IF OLD."status" = 'RESOLVED' THEN
    RAISE EXCEPTION 'A resolved low-stock alert cannot change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'inventory_stock_alerts_frozen';
  END IF;

  IF NEW."id" <> OLD."id"
     OR NEW."organization_id" <> OLD."organization_id"
     OR NEW."location_id" <> OLD."location_id"
     OR NEW."inventory_item_id" <> OLD."inventory_item_id"
     OR NEW."quantity_when_opened" <> OLD."quantity_when_opened"
     OR NEW."reorder_level_when_opened" <> OLD."reorder_level_when_opened"
     OR NEW."opened_at" <> OLD."opened_at"
     OR NEW."opened_by_transaction_id" <> OLD."opened_by_transaction_id"
     OR NEW."created_at" <> OLD."created_at" THEN
    RAISE EXCEPTION 'A low-stock alert''s facts cannot change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'inventory_stock_alerts_frozen';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "inventory_stock_alerts_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "inventory_stock_alerts"
  FOR EACH ROW EXECUTE FUNCTION "inventory_stock_alerts_guard"();
--> statement-breakpoint

-- Policy 13: a notification can still only be marked read; its new alert link is frozen too.
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
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'A notification can only be marked read'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'notifications_frozen';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
