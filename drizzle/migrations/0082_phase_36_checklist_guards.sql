-- Custom migration: Phase 36 checklist guards (policy 5, policy 3).

-- Templates and their items are deactivated, never deleted.
CREATE FUNCTION "checklist_config_no_delete"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Checklist templates and items are deactivated, never deleted'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'checklist_config_no_delete';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "checklist_templates_no_delete_trigger"
  BEFORE DELETE ON "checklist_templates"
  FOR EACH ROW EXECUTE FUNCTION "checklist_config_no_delete"();
--> statement-breakpoint
CREATE TRIGGER "checklist_template_items_no_delete_trigger"
  BEFORE DELETE ON "checklist_template_items"
  FOR EACH ROW EXECUTE FUNCTION "checklist_config_no_delete"();
--> statement-breakpoint

-- A run keeps what it was started as. Once completed it changes only by its one sign-off.
CREATE FUNCTION "checklist_runs_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Checklist runs are never deleted'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'checklist_runs_no_delete';
  END IF;

  IF NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
    OR NEW."location_id" IS DISTINCT FROM OLD."location_id"
    OR NEW."template_id" IS DISTINCT FROM OLD."template_id"
    OR NEW."business_date" IS DISTINCT FROM OLD."business_date"
    OR NEW."kind" IS DISTINCT FROM OLD."kind"
    OR NEW."template_name_snapshot" IS DISTINCT FROM OLD."template_name_snapshot"
    OR NEW."requires_sign_off" IS DISTINCT FROM OLD."requires_sign_off"
    OR NEW."employee_id" IS DISTINCT FROM OLD."employee_id"
    OR NEW."started_by_user_id" IS DISTINCT FROM OLD."started_by_user_id"
    OR NEW."started_at" IS DISTINCT FROM OLD."started_at"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'A checklist run keeps what it was started as'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'checklist_runs_frozen_copy';
  END IF;

  IF OLD."status" = 'COMPLETED' THEN
    IF NEW."status" <> 'COMPLETED'
      OR NEW."completed_by_user_id" IS DISTINCT FROM OLD."completed_by_user_id"
      OR NEW."completed_at" IS DISTINCT FROM OLD."completed_at"
      OR OLD."signed_off_at" IS NOT NULL
      OR NEW."signed_off_at" IS NULL THEN
      RAISE EXCEPTION 'A completed checklist changes only by its one sign-off'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'checklist_runs_completed_frozen';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "checklist_runs_guard_trigger"
  BEFORE UPDATE OR DELETE ON "checklist_runs"
  FOR EACH ROW EXECUTE FUNCTION "checklist_runs_guard"();
--> statement-breakpoint

-- A run item is added only to an open run and keeps its copied task. Once its run is completed
-- it changes only by a guest erase's recorded redaction of its note or skip reason.
CREATE FUNCTION "checklist_run_items_guard"() RETURNS trigger AS $$
DECLARE
  run_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Checklist run items are never deleted'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'checklist_run_items_no_delete';
  END IF;

  SELECT "status" INTO run_status FROM "checklist_runs" WHERE "id" = NEW."run_id";

  IF TG_OP = 'INSERT' THEN
    IF run_status IS DISTINCT FROM 'OPEN' THEN
      RAISE EXCEPTION 'Items are added only to an open checklist'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'checklist_run_items_completed_frozen';
    END IF;

    RETURN NEW;
  END IF;

  IF NEW."run_id" IS DISTINCT FROM OLD."run_id"
    OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
    OR NEW."template_item_id" IS DISTINCT FROM OLD."template_item_id"
    OR NEW."text_snapshot" IS DISTINCT FROM OLD."text_snapshot"
    OR NEW."required" IS DISTINCT FROM OLD."required"
    OR NEW."sort_order" IS DISTINCT FROM OLD."sort_order" THEN
    RAISE EXCEPTION 'A checklist item keeps its copied task'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'checklist_run_items_frozen_copy';
  END IF;

  IF run_status = 'COMPLETED' THEN
    IF NEW."state" IS DISTINCT FROM OLD."state"
      OR NEW."acted_by_user_id" IS DISTINCT FROM OLD."acted_by_user_id"
      OR NEW."acted_at" IS DISTINCT FROM OLD."acted_at"
      OR NOT "text_unchanged_or_redacted"(OLD."note", NEW."note", 'checklist_run_items', OLD."id", 'note')
      OR NOT "text_unchanged_or_redacted"(OLD."skip_reason", NEW."skip_reason", 'checklist_run_items', OLD."id", 'skip_reason') THEN
      RAISE EXCEPTION 'A completed checklist''s items are frozen'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'checklist_run_items_completed_frozen';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "checklist_run_items_guard_trigger"
  BEFORE INSERT OR UPDATE OR DELETE ON "checklist_run_items"
  FOR EACH ROW EXECUTE FUNCTION "checklist_run_items_guard"();
