-- Custom migration: triggers Drizzle's schema language can't express.

-- The audit trail is append-only (README section 20). It reuses refuse_history_change()
-- from 0012 for row changes and also refuses TRUNCATE, which row triggers don't see.
CREATE TRIGGER "audit_events_append_only_trigger"
  BEFORE UPDATE OR DELETE ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION "refuse_history_change"();
--> statement-breakpoint

CREATE TRIGGER "audit_events_no_truncate_trigger"
  BEFORE TRUNCATE ON "audit_events"
  FOR EACH STATEMENT EXECUTE FUNCTION "refuse_history_change"();
