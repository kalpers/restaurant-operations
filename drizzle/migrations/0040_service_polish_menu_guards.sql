-- Custom migration: Phase 20 menu and stock (policies 1, 3 and 4).

-- Policy 4: existing 86es started when they were marked out. The guard refuses any change
-- to a RESTORED row, so it is paused for this one backfill.
ALTER TABLE "menu_item_outages" DISABLE TRIGGER "menu_item_outages_guard";
--> statement-breakpoint
UPDATE "menu_item_outages" SET "starts_at" = "marked_out_at";
--> statement-breakpoint
ALTER TABLE "menu_item_outages" ENABLE TRIGGER "menu_item_outages_guard";
--> statement-breakpoint

-- Policy 4: the one-ACTIVE partial unique index (dropped in 0039) becomes "no two ACTIVE
-- outages of one item at one location whose windows overlap". An open end is infinity.
ALTER TABLE "menu_item_outages" ADD CONSTRAINT "menu_item_outages_no_overlap"
  EXCLUDE USING gist (
    "location_id" WITH =,
    "menu_item_id" WITH =,
    tstzrange("starts_at", "ends_at", '[)') WITH &&
  ) WHERE ("status" = 'ACTIVE');
--> statement-breakpoint
ALTER TABLE "modifier_outages" ADD CONSTRAINT "modifier_outages_no_overlap"
  EXCLUDE USING gist (
    "location_id" WITH =,
    "modifier_id" WITH =,
    tstzrange("starts_at", "ends_at", '[)') WITH &&
  ) WHERE ("status" = 'ACTIVE');
--> statement-breakpoint

-- The item outage guard now also freezes the window.
CREATE OR REPLACE FUNCTION "menu_item_outages_guard"() RETURNS trigger AS $$
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
     OR NEW."starts_at" <> OLD."starts_at"
     OR NEW."ends_at" IS DISTINCT FROM OLD."ends_at"
     OR NEW."created_at" <> OLD."created_at" THEN
    RAISE EXCEPTION 'An 86 record''s facts cannot change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'menu_item_outages_frozen';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- Policy 3: a modifier outage has the item outage's lifecycle.
CREATE FUNCTION "modifier_outages_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A modifier 86 record cannot be deleted'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'modifier_outages_no_delete';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'ACTIVE' THEN
      RAISE EXCEPTION 'A modifier 86 record starts ACTIVE'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'modifier_outages_starts_active';
    END IF;

    RETURN NEW;
  END IF;

  IF OLD."status" = 'RESTORED' THEN
    RAISE EXCEPTION 'A restored modifier 86 record cannot change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'modifier_outages_frozen';
  END IF;

  IF NEW."id" <> OLD."id"
     OR NEW."organization_id" <> OLD."organization_id"
     OR NEW."location_id" <> OLD."location_id"
     OR NEW."modifier_id" <> OLD."modifier_id"
     OR NEW."reason" <> OLD."reason"
     OR NEW."marked_out_at" <> OLD."marked_out_at"
     OR NEW."marked_out_by_user_id" <> OLD."marked_out_by_user_id"
     OR NEW."starts_at" <> OLD."starts_at"
     OR NEW."ends_at" IS DISTINCT FROM OLD."ends_at"
     OR NEW."created_at" <> OLD."created_at" THEN
    RAISE EXCEPTION 'A modifier 86 record''s facts cannot change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'modifier_outages_frozen';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "modifier_outages_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "modifier_outages"
  FOR EACH ROW EXECUTE FUNCTION "modifier_outages_guard"();
--> statement-breakpoint

-- Policy 1: the category snapshot is frozen at SEND with the other snapshots.
CREATE OR REPLACE FUNCTION "order_items_freeze"() RETURNS trigger AS $$
DECLARE
  moving boolean;
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

  IF moving AND NOT EXISTS (
    SELECT 1 FROM "order_item_transfers"
    WHERE "order_item_id" = NEW."id" AND "from_order_id" = OLD."order_id"
      AND "to_order_id" = NEW."order_id" AND "moved_at" = now()
  ) THEN
    RAISE EXCEPTION 'A sent order item moves to another order only through a recorded transfer'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'order_items_frozen';
  END IF;

  IF OLD."status" = 'VOIDED'
    OR (NOT moving AND NEW."status" <> 'VOIDED')
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
    OR NEW."menu_category_id" IS DISTINCT FROM OLD."menu_category_id"
    OR NEW."menu_category_name_snapshot" IS DISTINCT FROM OLD."menu_category_name_snapshot"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'A sent order item''s snapshot cannot be changed'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'order_items_frozen';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
