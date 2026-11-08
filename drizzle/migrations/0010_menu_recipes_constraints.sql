-- Custom migration: Drizzle's schema language can't express exclusion constraints or
-- triggers. btree_gist comes from 0003. All intervals are half-open: [from, to).

-- A menu item has at most one price in force per scope (organization default, or one
-- location) at any instant. The nil UUID stands in for the organization default scope.
ALTER TABLE "menu_item_prices"
  ADD CONSTRAINT "menu_item_prices_no_overlap"
  EXCLUDE USING gist (
    "menu_item_id" WITH =,
    (coalesce("location_id", '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
    tstzrange("effective_from", "effective_to", '[)') WITH &&
  );
--> statement-breakpoint

-- A menu's availability windows at a location don't overlap.
ALTER TABLE "menu_availability"
  ADD CONSTRAINT "menu_availability_no_overlap"
  EXCLUDE USING gist (
    "menu_id" WITH =,
    "location_id" WITH =,
    tstzrange("effective_from", "effective_to", '[)') WITH &&
  );
--> statement-breakpoint

-- At most one recipe revision is in effect at any instant. Drafts have no interval and
-- are exempt; a retired revision keeps its closed interval as history.
ALTER TABLE "recipe_versions"
  ADD CONSTRAINT "recipe_versions_no_overlap"
  EXCLUDE USING gist (
    "recipe_id" WITH =,
    tstzrange("effective_from", "effective_to", '[)') WITH &&
  )
  WHERE ("status" IN ('PUBLISHED', 'RETIRED'));
--> statement-breakpoint

-- Revision content is frozen once it leaves DRAFT. Status, interval and provenance columns
-- may still change (publish, close, retire), but yield, units, notes and numbering may not.
CREATE FUNCTION "recipe_versions_freeze_content"() RETURNS trigger AS $$
BEGIN
  IF OLD."status" <> 'DRAFT' AND (
    NEW."recipe_id" IS DISTINCT FROM OLD."recipe_id"
    OR NEW."revision_number" IS DISTINCT FROM OLD."revision_number"
    OR NEW."yield_quantity" IS DISTINCT FROM OLD."yield_quantity"
    OR NEW."yield_unit_id" IS DISTINCT FROM OLD."yield_unit_id"
    OR NEW."preparation_notes" IS DISTINCT FROM OLD."preparation_notes"
  ) THEN
    RAISE EXCEPTION 'A published recipe revision cannot be changed'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'recipe_versions_content_frozen';
  END IF;

  IF OLD."status" <> 'DRAFT' AND NEW."status" = 'DRAFT' THEN
    RAISE EXCEPTION 'A published recipe revision cannot return to draft'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'recipe_versions_content_frozen';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER "recipe_versions_freeze_content_trigger"
  BEFORE UPDATE ON "recipe_versions"
  FOR EACH ROW EXECUTE FUNCTION "recipe_versions_freeze_content"();
--> statement-breakpoint

-- Recipe revisions are history: they can't be deleted once published.
CREATE FUNCTION "recipe_versions_forbid_published_delete"() RETURNS trigger AS $$
BEGIN
  IF OLD."status" <> 'DRAFT' THEN
    RAISE EXCEPTION 'A published recipe revision cannot be deleted'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'recipe_versions_content_frozen';
  END IF;

  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER "recipe_versions_forbid_published_delete_trigger"
  BEFORE DELETE ON "recipe_versions"
  FOR EACH ROW EXECUTE FUNCTION "recipe_versions_forbid_published_delete"();
