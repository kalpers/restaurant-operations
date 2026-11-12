-- Custom migration: Phase 22 consent and manage-link guards (policies 5 and 11).

-- Policy 5: a consent is never deleted or re-opened. It changes only to be withdrawn (once),
-- and its address may only be cleared, after it is withdrawn (erase, D14).
CREATE FUNCTION "guest_party_message_consents_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A message consent cannot be deleted'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'guest_party_message_consents_no_delete';
  END IF;

  IF NEW."id" <> OLD."id"
     OR NEW."guest_party_id" <> OLD."guest_party_id"
     OR NEW."channel" <> OLD."channel"
     OR NEW."granted_at" <> OLD."granted_at"
     OR NEW."source" <> OLD."source"
     OR NEW."granted_by_user_id" IS DISTINCT FROM OLD."granted_by_user_id"
     OR NEW."created_at" <> OLD."created_at"
     OR (NEW."address" IS DISTINCT FROM OLD."address" AND NEW."address" IS NOT NULL) THEN
    RAISE EXCEPTION 'A message consent cannot be changed, only withdrawn'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'guest_party_message_consents_frozen';
  END IF;

  IF OLD."withdrawn_at" IS NOT NULL AND (
       NEW."withdrawn_at" IS DISTINCT FROM OLD."withdrawn_at"
    OR NEW."withdrawn_by_user_id" IS DISTINCT FROM OLD."withdrawn_by_user_id"
    OR NEW."withdraw_reason" IS DISTINCT FROM OLD."withdraw_reason"
  ) THEN
    RAISE EXCEPTION 'A withdrawn message consent cannot be re-opened or changed'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'guest_party_message_consents_frozen';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "guest_party_message_consents_guard"
  BEFORE UPDATE OR DELETE ON "guest_party_message_consents"
  FOR EACH ROW EXECUTE FUNCTION "guest_party_message_consents_guard"();
--> statement-breakpoint

-- Policy 11: a manage link's token never changes. It can be revoked once, and the row can be
-- deleted only after it expired or was revoked (retention).
CREATE FUNCTION "reservation_manage_links_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."revoked_at" IS NULL AND OLD."expires_at" > now() THEN
      RAISE EXCEPTION 'A live manage link cannot be deleted; revoke it instead'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'reservation_manage_links_no_delete';
    END IF;

    RETURN OLD;
  END IF;

  IF NEW."id" <> OLD."id"
     OR NEW."reservation_id" <> OLD."reservation_id"
     OR NEW."token_hash" <> OLD."token_hash"
     OR NEW."created_at" <> OLD."created_at"
     OR NEW."expires_at" <> OLD."expires_at"
     OR (OLD."revoked_at" IS NOT NULL AND NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at") THEN
    RAISE EXCEPTION 'A manage link can only be revoked'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'reservation_manage_links_frozen';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "reservation_manage_links_guard"
  BEFORE UPDATE OR DELETE ON "reservation_manage_links"
  FOR EACH ROW EXECUTE FUNCTION "reservation_manage_links_guard"();
