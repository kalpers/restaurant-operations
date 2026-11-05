-- Custom migration: Drizzle's schema language can't express exclusion constraints.
-- Each effective period is an inclusive date range; a NULL end means open-ended.
-- btree_gist lets a GiST exclusion constraint compare UUIDs with equality.
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
ALTER TABLE "employee_locations"
  ADD CONSTRAINT "employee_locations_no_overlap"
  EXCLUDE USING gist (
    "employee_id" WITH =,
    "location_id" WITH =,
    daterange("effective_from", "effective_to", '[]') WITH &&
  );
--> statement-breakpoint
ALTER TABLE "employee_positions"
  ADD CONSTRAINT "employee_positions_no_overlap"
  EXCLUDE USING gist (
    "employee_id" WITH =,
    "position_id" WITH =,
    "location_id" WITH =,
    daterange("effective_from", "effective_to", '[]') WITH &&
  );
--> statement-breakpoint
ALTER TABLE "employee_position_compensation"
  ADD CONSTRAINT "employee_position_compensation_no_overlap"
  EXCLUDE USING gist (
    "employee_id" WITH =,
    "position_id" WITH =,
    daterange("effective_from", "effective_to", '[]') WITH &&
  );
