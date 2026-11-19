-- Custom migration: Phase 31 gift card guards (policies 7 and 11, amendment 3).

-- The gift card ledger is append-only, and each entry continues its card's running balance:
-- balance_after = the previous entry's balance_after (0 for the first) + amount. Entries of one
-- card are written under the lock on its card row, so "previous" is well defined.
CREATE FUNCTION "gift_card_entries_guard"() RETURNS trigger AS $$
DECLARE
  previous numeric(12, 2);
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'A gift card entry cannot be changed or deleted'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'gift_card_entries_append_only';
  END IF;

  SELECT "balance_after" INTO previous
  FROM "gift_card_entries"
  WHERE "gift_card_id" = NEW."gift_card_id"
  ORDER BY "sequence" DESC
  LIMIT 1;

  IF NEW."balance_after" <> COALESCE(previous, 0) + NEW."amount" THEN
    RAISE EXCEPTION 'A gift card entry must continue its card''s balance'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'gift_card_entries_running_balance';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "gift_card_entries_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "gift_card_entries"
  FOR EACH ROW EXECUTE FUNCTION "gift_card_entries_guard"();
--> statement-breakpoint

-- A card's balance always equals its latest entry (0 with none); its identity never changes,
-- and it is never deleted (deactivate it instead).
CREATE FUNCTION "gift_cards_guard"() RETURNS trigger AS $$
DECLARE
  latest numeric(12, 2);
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A gift card cannot be deleted; deactivate it instead'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'gift_cards_matches_ledger';
  END IF;

  IF TG_OP = 'UPDATE' AND (NEW."organization_id" <> OLD."organization_id"
     OR NEW."card_number" <> OLD."card_number" OR NEW."issued_location_id" <> OLD."issued_location_id"
     OR NEW."issued_at" <> OLD."issued_at") THEN
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
CREATE TRIGGER "gift_cards_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "gift_cards"
  FOR EACH ROW EXECUTE FUNCTION "gift_cards_guard"();
--> statement-breakpoint

-- A sale is never deleted, and only RECORDED -> VOIDED may change it: the void fields are set
-- once and nothing else about the sale moves.
CREATE FUNCTION "gift_card_sales_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A gift card sale cannot be deleted; void it instead'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'gift_card_sales_frozen';
  END IF;

  IF OLD."status" <> 'RECORDED' OR NEW."status" <> 'VOIDED'
     OR NEW."organization_id" <> OLD."organization_id" OR NEW."location_id" <> OLD."location_id"
     OR NEW."gift_card_id" <> OLD."gift_card_id" OR NEW."kind" <> OLD."kind"
     OR NEW."amount" <> OLD."amount" OR NEW."tender_type" <> OLD."tender_type"
     OR NEW."received_amount" IS DISTINCT FROM OLD."received_amount"
     OR NEW."change_amount" <> OLD."change_amount"
     OR NEW."cash_drawer_session_id" IS DISTINCT FROM OLD."cash_drawer_session_id"
     OR NEW."business_date" <> OLD."business_date" OR NEW."sold_at" <> OLD."sold_at"
     OR NEW."sold_by_user_id" <> OLD."sold_by_user_id"
     OR NEW."idempotency_record_id" <> OLD."idempotency_record_id" THEN
    RAISE EXCEPTION 'A gift card sale can only be voided'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'gift_card_sales_frozen';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "gift_card_sales_guard"
  BEFORE UPDATE OR DELETE ON "gift_card_sales"
  FOR EACH ROW EXECUTE FUNCTION "gift_card_sales_guard"();
--> statement-breakpoint

-- Cash for a card sale goes into, and a voided cash sale or a cash-out comes out of, an OPEN
-- drawer session at the same location (policies 4, 11, 12), with the Phase 17 guard.
CREATE TRIGGER "gift_card_sales_drawer_open_trigger"
  BEFORE INSERT OR UPDATE ON "gift_card_sales"
  FOR EACH ROW EXECUTE FUNCTION "cash_drawer_session_open_guard"();
--> statement-breakpoint
CREATE TRIGGER "gift_card_entries_drawer_open_trigger"
  BEFORE INSERT ON "gift_card_entries"
  FOR EACH ROW EXECUTE FUNCTION "cash_drawer_session_open_guard"();
