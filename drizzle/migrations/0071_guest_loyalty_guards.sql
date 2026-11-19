-- Custom migration: Phase 30 guest loyalty guards (policy 6, amendment 8).

-- The points ledger is append-only, and each entry continues its profile's running balance:
-- balance_after = the previous entry's balance_after (0 for the first) + points. Entries of one
-- profile are written under the lock on its balance row, so "previous" is well defined.
CREATE FUNCTION "guest_loyalty_entries_guard"() RETURNS trigger AS $$
DECLARE
  previous integer;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'A loyalty entry cannot be changed or deleted'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'guest_loyalty_entries_append_only';
  END IF;

  SELECT "balance_after" INTO previous
  FROM "guest_loyalty_entries"
  WHERE "guest_profile_id" = NEW."guest_profile_id"
  ORDER BY "sequence" DESC
  LIMIT 1;

  IF NEW."balance_after" <> COALESCE(previous, 0) + NEW."points" THEN
    RAISE EXCEPTION 'A loyalty entry must continue its profile''s balance'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'guest_loyalty_entries_running_balance';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "guest_loyalty_entries_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "guest_loyalty_entries"
  FOR EACH ROW EXECUTE FUNCTION "guest_loyalty_entries_guard"();
--> statement-breakpoint

-- The balance row always equals its profile's latest entry (0 with none), and is never deleted.
CREATE FUNCTION "guest_loyalty_balances_guard"() RETURNS trigger AS $$
DECLARE
  latest integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A loyalty balance cannot be deleted'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'guest_loyalty_balances_matches_ledger';
  END IF;

  IF TG_OP = 'UPDATE' AND (NEW."guest_profile_id" <> OLD."guest_profile_id"
     OR NEW."organization_id" <> OLD."organization_id") THEN
    RAISE EXCEPTION 'A loyalty balance''s profile cannot change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'guest_loyalty_balances_matches_ledger';
  END IF;

  SELECT "balance_after" INTO latest
  FROM "guest_loyalty_entries"
  WHERE "guest_profile_id" = NEW."guest_profile_id"
  ORDER BY "sequence" DESC
  LIMIT 1;

  IF NEW."balance" <> COALESCE(latest, 0) THEN
    RAISE EXCEPTION 'A loyalty balance must equal its latest ledger entry'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'guest_loyalty_balances_matches_ledger';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "guest_loyalty_balances_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "guest_loyalty_balances"
  FOR EACH ROW EXECUTE FUNCTION "guest_loyalty_balances_guard"();
--> statement-breakpoint

-- A redemption record is append-only: whether it is pending, posted or dropped is worked out
-- from its order, its discount and its REDEEMED entry.
CREATE FUNCTION "guest_loyalty_redemptions_guard"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'A loyalty redemption cannot be changed or deleted'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'guest_loyalty_redemptions_append_only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "guest_loyalty_redemptions_guard"
  BEFORE UPDATE OR DELETE ON "guest_loyalty_redemptions"
  FOR EACH ROW EXECUTE FUNCTION "guest_loyalty_redemptions_guard"();
--> statement-breakpoint

-- A reward's discount definition must be reward-only, and keeps that flag (policy 7).
CREATE FUNCTION "guest_loyalty_rewards_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A loyalty reward cannot be deleted; deactivate it instead'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'guest_loyalty_rewards_no_delete';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "discount_definitions"
    WHERE "id" = NEW."discount_definition_id" AND "reward_only" AND "organization_id" = NEW."organization_id"
  ) THEN
    RAISE EXCEPTION 'A loyalty reward needs a reward-only discount of its organization'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'guest_loyalty_rewards_reward_only';
  END IF;

  IF TG_OP = 'UPDATE' AND (NEW."discount_definition_id" <> OLD."discount_definition_id"
     OR NEW."reward_number" <> OLD."reward_number" OR NEW."organization_id" <> OLD."organization_id") THEN
    RAISE EXCEPTION 'A loyalty reward''s identity cannot change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'guest_loyalty_rewards_reward_only';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "guest_loyalty_rewards_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "guest_loyalty_rewards"
  FOR EACH ROW EXECUTE FUNCTION "guest_loyalty_rewards_guard"();
--> statement-breakpoint

CREATE FUNCTION "discount_definitions_reward_only_guard"() RETURNS trigger AS $$
BEGIN
  IF NEW."reward_only" IS DISTINCT FROM OLD."reward_only" THEN
    RAISE EXCEPTION 'Whether a discount is reward-only cannot change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'discount_definitions_reward_only_fixed';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "discount_definitions_reward_only_guard"
  BEFORE UPDATE ON "discount_definitions"
  FOR EACH ROW EXECUTE FUNCTION "discount_definitions_reward_only_guard"();
