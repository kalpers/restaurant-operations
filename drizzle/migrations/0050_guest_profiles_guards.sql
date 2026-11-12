-- Custom migration: Phase 21 guest profiles and allergen snapshots (policies 1, 3, 11, 14).

-- Policy 1: a profile is never deleted; it changes from ACTIVE only to MERGED or ERASED, and an
-- ERASED profile never changes again. A MERGED profile changes once more, only to have its
-- personal data erased with the profile it was merged into (amendment 4). Its identity never
-- changes.
CREATE FUNCTION "guest_profiles_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A guest profile cannot be deleted; erase it instead'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'guest_profiles_no_delete';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'ACTIVE' THEN
      RAISE EXCEPTION 'A guest profile starts ACTIVE'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'guest_profiles_starts_active';
    END IF;

    RETURN NEW;
  END IF;

  IF OLD."status" = 'MERGED' AND OLD."erased_at" IS NULL AND NEW."erased_at" IS NOT NULL
     AND NEW."status" = 'MERGED'
     AND NEW."merged_into_profile_id" IS NOT DISTINCT FROM OLD."merged_into_profile_id"
     AND NEW."display_name" = 'Erased guest'
     AND NEW."phone" IS NULL AND NEW."phone_normalized" IS NULL
     AND NEW."email" IS NULL AND NEW."email_normalized" IS NULL
     AND NOT NEW."vip" AND NEW."vip_reason" IS NULL
     AND NEW."preferences" IS NULL AND NEW."notes" IS NULL AND NEW."other_dietary_needs" IS NULL THEN
    NULL;
  ELSIF OLD."status" <> 'ACTIVE' THEN
    RAISE EXCEPTION 'A % guest profile cannot change', OLD."status"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'guest_profiles_frozen';
  END IF;

  IF NEW."id" <> OLD."id"
     OR NEW."organization_id" <> OLD."organization_id"
     OR NEW."profile_number" <> OLD."profile_number"
     OR NEW."created_by_user_id" <> OLD."created_by_user_id"
     OR NEW."created_at" <> OLD."created_at" THEN
    RAISE EXCEPTION 'A guest profile''s identity cannot change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'guest_profiles_frozen';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "guest_profiles_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "guest_profiles"
  FOR EACH ROW EXECUTE FUNCTION "guest_profiles_guard"();
--> statement-breakpoint

-- Policy 3: a merge record is append-only.
CREATE FUNCTION "guest_profile_merges_guard"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'A guest profile merge record cannot be changed or deleted'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'guest_profile_merges_append_only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "guest_profile_merges_guard"
  BEFORE UPDATE OR DELETE ON "guest_profile_merges"
  FOR EACH ROW EXECUTE FUNCTION "guest_profile_merges_guard"();
--> statement-breakpoint

-- Policy 11: an item's allergen snapshot is written once, at SEND, while the item is being
-- sent in this transaction, and never changes.
CREATE FUNCTION "order_item_allergens_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM "order_items" i
      JOIN "order_send_batches" b ON b."id" = i."send_batch_id"
      WHERE i."id" = NEW."order_item_id" AND i."status" = 'SUBMITTED' AND b."created_at" = now()
    ) THEN
      RAISE EXCEPTION 'An allergen snapshot is written only when its item is sent'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'order_item_allergens_at_send';
    END IF;

    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'An allergen snapshot cannot be changed or deleted'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'order_item_allergens_frozen';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "order_item_allergens_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "order_item_allergens"
  FOR EACH ROW EXECUTE FUNCTION "order_item_allergens_guard"();
--> statement-breakpoint

-- Policy 14: the acknowledgment and label snapshot are frozen with the item's other snapshots.
-- The rest of the function is unchanged from 0046.
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
    OR NEW."allergen_label_incomplete_snapshot" IS DISTINCT FROM OLD."allergen_label_incomplete_snapshot"
    OR NEW."allergy_acknowledged_by_user_id" IS DISTINCT FROM OLD."allergy_acknowledged_by_user_id"
    OR NEW."allergy_acknowledged_at" IS DISTINCT FROM OLD."allergy_acknowledged_at"
    OR NEW."allergy_conflict_snapshot" IS DISTINCT FROM OLD."allergy_conflict_snapshot"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'A sent order item''s snapshot cannot be changed'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'order_items_frozen';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- Policy 14: the ticket's allergy alert is frozen with its other snapshots. The rest of the
-- function is unchanged from 0029.
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
    OR NEW."allergy_alert_snapshot" IS DISTINCT FROM OLD."allergy_alert_snapshot"
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
