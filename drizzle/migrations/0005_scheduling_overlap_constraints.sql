-- Custom migration: Drizzle's schema language can't express exclusion constraints.
-- Two published periods at one location can't share a date. Draft and archived periods
-- are exempt, because only a published schedule is in force. btree_gist comes from 0003.
ALTER TABLE "schedule_periods"
  ADD CONSTRAINT "schedule_periods_no_overlap"
  EXCLUDE USING gist (
    "location_id" WITH =,
    daterange("start_date", "end_date", '[]') WITH &&
  )
  WHERE ("status" = 'PUBLISHED');
