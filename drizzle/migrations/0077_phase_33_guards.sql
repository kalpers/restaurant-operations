-- Custom migration: Phase 33 (policies 5, 17).

-- The six categories every organization starts with (policy 17, amendment 2). Existing entries
-- already use these codes, so they must exist before the category foreign key is added. That
-- key is generated with 0076's snapshot but added here, after the rows.
INSERT INTO "manager_log_categories" ("organization_id", "code", "name", "sort_order")
SELECT o."id", d."code", d."name", d."sort_order"
FROM "organizations" o
CROSS JOIN (VALUES
  ('SERVICE', 'Service', 10),
  ('INCIDENT', 'Incident', 20),
  ('MAINTENANCE', 'Maintenance', 30),
  ('STAFFING', 'Staffing', 40),
  ('GUEST', 'Guest', 50),
  ('OTHER', 'Other', 60)
) AS d("code", "name", "sort_order")
ON CONFLICT ("organization_id", "code") DO NOTHING;
--> statement-breakpoint
ALTER TABLE "manager_log_entries" ADD CONSTRAINT "manager_log_entries_category_fk" FOREIGN KEY ("organization_id","category") REFERENCES "public"."manager_log_categories"("organization_id","code") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- A category is deactivated, never deleted (policy 18).
CREATE FUNCTION "manager_log_categories_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A manager log category cannot be deleted; deactivate it instead'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'manager_log_categories_not_deleted';
  END IF;

  IF NEW."organization_id" <> OLD."organization_id" OR NEW."code" <> OLD."code" THEN
    RAISE EXCEPTION 'A manager log category''s code cannot change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'manager_log_categories_code_fixed';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "manager_log_categories_guard"
  BEFORE UPDATE OR DELETE ON "manager_log_categories"
  FOR EACH ROW EXECUTE FUNCTION "manager_log_categories_guard"();
--> statement-breakpoint
-- A redacted pre-shift note stays as it was redacted, for good (policy 5).
CREATE FUNCTION "pre_shift_notes_redaction_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF OLD."redacted_at" IS NOT NULL THEN
    RAISE EXCEPTION 'A redacted pre-shift note cannot change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'pre_shift_notes_redaction_final';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "pre_shift_notes_redaction_guard"
  BEFORE UPDATE ON "pre_shift_notes"
  FOR EACH ROW EXECUTE FUNCTION "pre_shift_notes_redaction_guard"();
