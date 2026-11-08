-- Custom migration: triggers Drizzle's schema language can't express.

-- Posted history is append-only. A correction is a compensating row, never an edit.
CREATE FUNCTION "refuse_history_change"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only history and cannot be changed', TG_TABLE_NAME
    USING ERRCODE = 'check_violation', CONSTRAINT = TG_TABLE_NAME || '_append_only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER "inventory_transactions_append_only_trigger"
  BEFORE UPDATE OR DELETE ON "inventory_transactions"
  FOR EACH ROW EXECUTE FUNCTION "refuse_history_change"();
--> statement-breakpoint

CREATE TRIGGER "purchase_order_receipts_append_only_trigger"
  BEFORE UPDATE OR DELETE ON "purchase_order_receipts"
  FOR EACH ROW EXECUTE FUNCTION "refuse_history_change"();
--> statement-breakpoint

CREATE TRIGGER "purchase_order_receipt_lines_append_only_trigger"
  BEFORE UPDATE OR DELETE ON "purchase_order_receipt_lines"
  FOR EACH ROW EXECUTE FUNCTION "refuse_history_change"();
--> statement-breakpoint

CREATE TRIGGER "supplier_item_cost_history_append_only_trigger"
  BEFORE UPDATE OR DELETE ON "supplier_item_cost_history"
  FOR EACH ROW EXECUTE FUNCTION "refuse_history_change"();
--> statement-breakpoint

-- A published recipe revision's ingredients are frozen with the rest of its content.
CREATE FUNCTION "recipe_version_ingredients_freeze"() RETURNS trigger AS $$
DECLARE
  revision_status text;
BEGIN
  SELECT "status" INTO revision_status FROM "recipe_versions"
    WHERE "id" = COALESCE(NEW."recipe_version_id", OLD."recipe_version_id");

  IF revision_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'Ingredients of a published recipe revision cannot be changed'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'recipe_version_ingredients_frozen';
  END IF;

  IF TG_OP = 'UPDATE' AND NEW."recipe_version_id" IS DISTINCT FROM OLD."recipe_version_id" THEN
    RAISE EXCEPTION 'An ingredient cannot move to another revision'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'recipe_version_ingredients_frozen';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER "recipe_version_ingredients_freeze_trigger"
  BEFORE INSERT OR UPDATE OR DELETE ON "recipe_version_ingredients"
  FOR EACH ROW EXECUTE FUNCTION "recipe_version_ingredients_freeze"();
