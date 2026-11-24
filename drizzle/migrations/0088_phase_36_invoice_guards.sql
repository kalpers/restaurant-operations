-- Custom migration: Phase 36 supplier invoice guards (policy 8, policy 3).

-- Invoices are voided, never deleted. They keep their number, location and supplier. An approved
-- invoice changes only by being voided; a voided one never changes. Either may take a guest
-- erase's recorded redaction of its notes.
CREATE FUNCTION "supplier_invoices_guard"() RETURNS trigger AS $$
DECLARE
  free_keys text[] := ARRAY['notes', 'dispute_reason', 'approval_reason', 'void_reason', 'updated_at', 'updated_by_user_id', 'version'];
  void_keys text[] := ARRAY['notes', 'dispute_reason', 'approval_reason', 'void_reason', 'updated_at', 'updated_by_user_id', 'version',
    'status', 'voided_at', 'voided_by_user_id'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Supplier invoices are voided, never deleted'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'supplier_invoices_no_delete';
  END IF;

  IF NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
    OR NEW."location_id" IS DISTINCT FROM OLD."location_id"
    OR NEW."supplier_id" IS DISTINCT FROM OLD."supplier_id"
    OR NEW."sequence_number" IS DISTINCT FROM OLD."sequence_number"
    OR NEW."invoice_number" IS DISTINCT FROM OLD."invoice_number"
    OR NEW."created_by_user_id" IS DISTINCT FROM OLD."created_by_user_id"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'An invoice keeps its number, location and supplier'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'supplier_invoices_identity_fixed';
  END IF;

  IF OLD."status" IN ('APPROVED', 'VOIDED') AND (
    (NEW."notes" IS DISTINCT FROM OLD."notes" AND NOT "free_text_redaction_recorded"('supplier_invoices', OLD."id", 'notes'))
    OR (NEW."dispute_reason" IS DISTINCT FROM OLD."dispute_reason"
      AND NOT "free_text_redaction_recorded"('supplier_invoices', OLD."id", 'dispute_reason'))
    OR (NEW."approval_reason" IS DISTINCT FROM OLD."approval_reason"
      AND NOT "free_text_redaction_recorded"('supplier_invoices', OLD."id", 'approval_reason'))
    OR (NEW."void_reason" IS DISTINCT FROM OLD."void_reason"
      AND NOT (OLD."status" = 'APPROVED' AND NEW."status" = 'VOIDED')
      AND NOT "free_text_redaction_recorded"('supplier_invoices', OLD."id", 'void_reason'))
  ) THEN
    RAISE EXCEPTION 'An approved or voided invoice is frozen'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'supplier_invoices_finished_frozen';
  END IF;

  IF OLD."status" = 'VOIDED' AND (to_jsonb(NEW) - free_keys) IS DISTINCT FROM (to_jsonb(OLD) - free_keys) THEN
    RAISE EXCEPTION 'A voided invoice is frozen'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'supplier_invoices_finished_frozen';
  END IF;

  IF OLD."status" = 'APPROVED' AND (to_jsonb(NEW) - free_keys) IS DISTINCT FROM (to_jsonb(OLD) - free_keys)
    AND NOT (NEW."status" = 'VOIDED' AND (to_jsonb(NEW) - void_keys) = (to_jsonb(OLD) - void_keys)) THEN
    RAISE EXCEPTION 'An approved invoice changes only by being voided'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'supplier_invoices_finished_frozen';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "supplier_invoices_guard_trigger"
  BEFORE UPDATE OR DELETE ON "supplier_invoices"
  FOR EACH ROW EXECUTE FUNCTION "supplier_invoices_guard"();
--> statement-breakpoint

-- Lines change only while their invoice is a draft or disputed. Voiding releases the receipt
-- lines (holds_receipt_line becomes false), nothing else. An item line's receipt is from the
-- invoice's location and supplier.
CREATE FUNCTION "supplier_invoice_lines_guard"() RETURNS trigger AS $$
DECLARE
  invoice record;
  receipt record;
  target uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD."invoice_id" ELSE NEW."invoice_id" END;
BEGIN
  SELECT "status", "location_id", "supplier_id" INTO invoice FROM "supplier_invoices" WHERE "id" = target;

  IF TG_OP = 'UPDATE' AND invoice."status" = 'VOIDED'
    AND (to_jsonb(NEW) - 'holds_receipt_line') = (to_jsonb(OLD) - 'holds_receipt_line')
    AND OLD."holds_receipt_line" AND NOT NEW."holds_receipt_line" THEN
    RETURN NEW;
  END IF;

  IF invoice."status" NOT IN ('DRAFT', 'DISPUTED') THEN
    RAISE EXCEPTION 'An approved or voided invoice''s lines are frozen'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'supplier_invoice_lines_frozen';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF NEW."receipt_line_id" IS NOT NULL THEN
    SELECT r."location_id", po."supplier_id" INTO receipt
    FROM "purchase_order_receipt_lines" rl
    JOIN "purchase_order_receipts" r ON r."id" = rl."receipt_id"
    JOIN "purchase_orders" po ON po."id" = r."purchase_order_id"
    WHERE rl."id" = NEW."receipt_line_id";

    IF receipt."location_id" IS DISTINCT FROM invoice."location_id" OR receipt."supplier_id" IS DISTINCT FROM invoice."supplier_id" THEN
      RAISE EXCEPTION 'An invoice line names a receipt from the invoice''s own location and supplier'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'supplier_invoice_lines_receipt_matches';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "supplier_invoice_lines_guard_trigger"
  BEFORE INSERT OR UPDATE OR DELETE ON "supplier_invoice_lines"
  FOR EACH ROW EXECUTE FUNCTION "supplier_invoice_lines_guard"();
--> statement-breakpoint

-- Stored variances are append-only.
CREATE FUNCTION "supplier_invoice_variances_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Invoice variances are kept as they were'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'supplier_invoice_variances_append_only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "supplier_invoice_variances_append_only_trigger"
  BEFORE UPDATE OR DELETE ON "supplier_invoice_variances"
  FOR EACH ROW EXECUTE FUNCTION "supplier_invoice_variances_append_only"();
