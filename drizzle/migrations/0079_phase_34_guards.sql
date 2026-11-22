-- Custom migration: Phase 34 guards (policies 6, 7, 12, 13; amendments 1, 3, 4).

-- Amendment 4: whether NEW is OLD with one or more pieces replaced by "[redacted]" and nothing
-- else changed. NEW's other pieces must appear in OLD in order, with something in every gap.
CREATE FUNCTION "is_text_redaction"(old_text text, new_text text) RETURNS boolean AS $$
DECLARE
  parts text[];
  pattern text := '^';
  i integer;
BEGIN
  IF old_text IS NULL OR new_text IS NULL OR new_text = old_text OR position('[redacted]' in new_text) = 0 THEN
    RETURN false;
  END IF;

  parts := string_to_array(new_text, '[redacted]');

  FOR i IN 1 .. array_length(parts, 1) LOOP
    IF i > 1 THEN
      pattern := pattern || '.+';
    END IF;

    pattern := pattern || regexp_replace(parts[i], '([.^$*+?()\[\]{}|\\])', '\\\1', 'g');
  END LOOP;

  RETURN old_text ~ (pattern || '$');
END;
$$ LANGUAGE plpgsql IMMUTABLE;
--> statement-breakpoint

-- Policy 13: a redaction is accepted only with its record written in the same transaction.
CREATE FUNCTION "free_text_redaction_recorded"(target_table text, target_row uuid, target_column text)
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM "free_text_redactions"
    WHERE "table_name" = target_table AND "row_id" = target_row AND "column_name" = target_column
      AND "created_at" = now()
  );
$$ LANGUAGE sql STABLE;
--> statement-breakpoint

-- Whether a frozen text column changed only by a recorded redaction (or not at all).
CREATE FUNCTION "text_unchanged_or_redacted"(old_text text, new_text text, target_table text, target_row uuid, target_column text)
RETURNS boolean AS $$
  SELECT new_text IS NOT DISTINCT FROM old_text
    OR ("is_text_redaction"(old_text, new_text) AND "free_text_redaction_recorded"(target_table, target_row, target_column));
$$ LANGUAGE sql STABLE;
--> statement-breakpoint

-- Policies 12–13: the redaction records are append-only.
CREATE FUNCTION "free_text_redactions_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Redaction records are append-only'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'free_text_redactions_append_only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "free_text_redactions_append_only_trigger"
  BEFORE UPDATE OR DELETE ON "free_text_redactions"
  FOR EACH ROW EXECUTE FUNCTION "free_text_redactions_append_only"();
--> statement-breakpoint

-- Policy 13, amendment 3: a sent item's instructions may change only by a recorded redaction,
-- in any status; every other snapshot is still compared. The rest is unchanged from 0069.
CREATE OR REPLACE FUNCTION "order_items_freeze"() RETURNS trigger AS $$
DECLARE
  moving boolean;
  splitting boolean;
  reseating boolean;
  redacting boolean;
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

  -- Phase 29 (policy 5, amendment 4): a sent or shared item may change seat on its own check;
  -- every snapshot below is still compared, so nothing else about it can change.
  reseating := OLD."status" IN ('SUBMITTED', 'SPLIT') AND NEW."status" = OLD."status"
    AND NEW."order_id" IS NOT DISTINCT FROM OLD."order_id"
    AND NEW."seat_number" IS DISTINCT FROM OLD."seat_number";

  -- Phase 34 (policy 13): a guest erase replaces words of the instructions with "[redacted]".
  redacting := NEW."status" = OLD."status"
    AND NEW."order_id" IS NOT DISTINCT FROM OLD."order_id"
    AND NEW."seat_number" IS NOT DISTINCT FROM OLD."seat_number"
    AND (NEW."special_instructions" IS DISTINCT FROM OLD."special_instructions"
      OR NEW."kitchen_instructions_snapshot" IS DISTINCT FROM OLD."kitchen_instructions_snapshot");

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

  IF (OLD."status" = 'VOIDED' AND NOT redacting)
    OR (OLD."status" = 'SPLIT' AND NOT reseating AND NOT redacting)
    OR (NOT moving AND NOT splitting AND NOT reseating AND NOT redacting AND NEW."status" <> 'VOIDED')
    OR (NOT moving AND NEW."order_id" IS DISTINCT FROM OLD."order_id")
    OR NEW."menu_item_id" IS DISTINCT FROM OLD."menu_item_id"
    OR NEW."quantity" IS DISTINCT FROM OLD."quantity"
    OR NEW."menu_item_code_snapshot" IS DISTINCT FROM OLD."menu_item_code_snapshot"
    OR NEW."menu_item_name_snapshot" IS DISTINCT FROM OLD."menu_item_name_snapshot"
    OR NEW."base_price_snapshot" IS DISTINCT FROM OLD."base_price_snapshot"
    OR NEW."modifier_total_snapshot" IS DISTINCT FROM OLD."modifier_total_snapshot"
    OR NEW."unit_price_snapshot" IS DISTINCT FROM OLD."unit_price_snapshot"
    OR NEW."line_total_snapshot" IS DISTINCT FROM OLD."line_total_snapshot"
    OR NOT "text_unchanged_or_redacted"(OLD."special_instructions", NEW."special_instructions",
      'order_items', NEW."id", 'special_instructions')
    OR NOT "text_unchanged_or_redacted"(OLD."kitchen_instructions_snapshot", NEW."kitchen_instructions_snapshot",
      'order_items', NEW."id", 'kitchen_instructions_snapshot')
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
    OR NEW."price_period_id" IS DISTINCT FROM OLD."price_period_id"
    OR NEW."price_period_name_snapshot" IS DISTINCT FROM OLD."price_period_name_snapshot"
    OR NEW."regular_price_snapshot" IS DISTINCT FROM OLD."regular_price_snapshot"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'A sent order item''s snapshot cannot be changed'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'order_items_frozen';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- Policy 13, amendment 3: a ticket item's copy of the instructions may change only by a
-- recorded redaction, in any status, with its status unchanged. The rest is unchanged from 0050.
CREATE OR REPLACE FUNCTION "kitchen_ticket_items_guard"() RETURNS trigger AS $$
DECLARE
  redacting boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A kitchen ticket item cannot be deleted'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'kitchen_ticket_items_frozen';
  END IF;

  redacting := NEW."kitchen_instructions_snapshot" IS DISTINCT FROM OLD."kitchen_instructions_snapshot"
    AND NEW."status" IS NOT DISTINCT FROM OLD."status";

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
    OR NOT "text_unchanged_or_redacted"(OLD."kitchen_instructions_snapshot", NEW."kitchen_instructions_snapshot",
      'kitchen_ticket_items', NEW."id", 'kitchen_instructions_snapshot')
    OR (redacting AND NEW."status" IS DISTINCT FROM OLD."status")
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

  IF OLD."status" IN ('COMPLETED', 'CANCELLED') AND NOT redacting THEN
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
--> statement-breakpoint

-- Amendment 3: a CLOSED order still can't change, except its takeout name by a recorded
-- redaction (nothing else on the row may move with it). The rest is unchanged from 0044.
CREATE OR REPLACE FUNCTION "orders_settlement_guard"() RETURNS trigger AS $$
BEGIN
  IF OLD."status" = 'CLOSED' THEN
    IF NEW."customer_name" IS DISTINCT FROM OLD."customer_name"
      AND "is_text_redaction"(OLD."customer_name", NEW."customer_name")
      AND "free_text_redaction_recorded"('orders', NEW."id", 'customer_name')
      -- total_due is generated, so it is still empty in NEW before the write.
      AND (to_jsonb(NEW) - 'customer_name' - 'updated_at' - 'version' - 'total_due')
        = (to_jsonb(OLD) - 'customer_name' - 'updated_at' - 'version' - 'total_due') THEN
      RETURN NEW;
    END IF;

    RAISE EXCEPTION 'A closed order cannot change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'orders_closed_frozen';
  END IF;

  IF NEW."status" = 'CLOSED' THEN
    IF NOT EXISTS (
      SELECT 1 FROM "order_settlements"
      WHERE "order_id" = NEW."id" AND "status" = 'COMPLETED'
        AND "order_amount_snapshot" = NEW."subtotal" + NEW."tax_total"
    ) THEN
      RAISE EXCEPTION 'An order closes only through a completed settlement'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'orders_close_requires_settlement';
    END IF;

    RETURN NEW;
  END IF;

  IF (NEW."status" IS DISTINCT FROM OLD."status"
      OR NEW."item_subtotal" IS DISTINCT FROM OLD."item_subtotal"
      OR NEW."discount_total" IS DISTINCT FROM OLD."discount_total"
      OR NEW."subtotal" IS DISTINCT FROM OLD."subtotal"
      OR NEW."tax_total" IS DISTINCT FROM OLD."tax_total"
      OR NEW."included_tax_total" IS DISTINCT FROM OLD."included_tax_total"
      OR NEW."tax_exempt" IS DISTINCT FROM OLD."tax_exempt")
    AND EXISTS (
      SELECT 1 FROM "order_settlements" WHERE "order_id" = NEW."id" AND "status" = 'OPEN'
    ) THEN
    RAISE EXCEPTION 'The order is being settled'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'orders_settlement_in_progress';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- Amendment 1: a card's identity never changes, except that a STOCK card is issued once, at
-- its sale. A deactivated card that was never sold can't be issued. The balance rule is
-- unchanged from 0073.
CREATE OR REPLACE FUNCTION "gift_cards_guard"() RETURNS trigger AS $$
DECLARE
  latest numeric(12, 2);
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A gift card cannot be deleted; deactivate it instead'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'gift_cards_matches_ledger';
  END IF;

  IF TG_OP = 'UPDATE' AND (NEW."organization_id" <> OLD."organization_id"
     OR NEW."card_number" <> OLD."card_number"
     OR NEW."stock_batch_id" IS DISTINCT FROM OLD."stock_batch_id"
     OR NEW."printed_serial" IS DISTINCT FROM OLD."printed_serial"
     OR (OLD."issued_at" IS NOT NULL AND (
       NEW."issued_location_id" IS DISTINCT FROM OLD."issued_location_id"
       OR NEW."issued_at" IS DISTINCT FROM OLD."issued_at"
       OR NEW."issued_by_user_id" IS DISTINCT FROM OLD."issued_by_user_id"))
     OR (OLD."issued_at" IS NULL AND NEW."issued_at" IS NOT NULL AND OLD."status" <> 'STOCK')) THEN
    RAISE EXCEPTION 'A gift card''s identity cannot change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'gift_cards_matches_ledger';
  END IF;

  SELECT "balance_after" INTO latest
  FROM "gift_card_entries"
  WHERE "gift_card_id" = NEW."id"
  ORDER BY "sequence" DESC
  LIMIT 1;

  IF NEW."balance" <> COALESCE(latest, 0) THEN
    RAISE EXCEPTION 'A gift card''s balance must equal its latest ledger entry'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'gift_cards_matches_ledger';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- Policies 6–7: stock batches and unclaimed reports are records, never changed or deleted.
CREATE FUNCTION "gift_card_records_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Gift card stock batches and unclaimed reports are append-only'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'gift_card_records_append_only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "gift_card_stock_batches_append_only_trigger"
  BEFORE UPDATE OR DELETE ON "gift_card_stock_batches"
  FOR EACH ROW EXECUTE FUNCTION "gift_card_records_append_only"();
--> statement-breakpoint
CREATE TRIGGER "gift_card_escheatments_append_only_trigger"
  BEFORE UPDATE OR DELETE ON "gift_card_escheatments"
  FOR EACH ROW EXECUTE FUNCTION "gift_card_records_append_only"();
--> statement-breakpoint

-- Policy 4: purchaser details are cleared, never deleted, and a cleared row stays cleared.
CREATE FUNCTION "gift_card_purchasers_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Purchaser details are cleared, never deleted'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'gift_card_purchasers_guard';
  END IF;

  IF OLD."cleared_at" IS NOT NULL OR NEW."gift_card_id" <> OLD."gift_card_id"
     OR NEW."organization_id" <> OLD."organization_id" THEN
    RAISE EXCEPTION 'Cleared purchaser details cannot change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'gift_card_purchasers_guard';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "gift_card_purchasers_guard_trigger"
  BEFORE UPDATE OR DELETE ON "gift_card_purchasers"
  FOR EACH ROW EXECUTE FUNCTION "gift_card_purchasers_guard"();
