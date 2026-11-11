ALTER TABLE "cash_drawer_movements" DROP CONSTRAINT "cash_drawer_movements_idempotency_record_id_idempotency_records_id_fk";
--> statement-breakpoint
ALTER TABLE "order_refunds" DROP CONSTRAINT "order_refunds_cash_drawer_session_id_cash_drawer_sessions_id_fk";
--> statement-breakpoint
ALTER TABLE "settlement_tenders" DROP CONSTRAINT "settlement_tenders_cash_drawer_session_id_cash_drawer_sessions_id_fk";
--> statement-breakpoint
ALTER TABLE "cash_drawer_movements" ADD CONSTRAINT "cash_drawer_movements_idempotency_fk" FOREIGN KEY ("idempotency_record_id") REFERENCES "public"."idempotency_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_refunds" ADD CONSTRAINT "order_refunds_drawer_session_fk" FOREIGN KEY ("cash_drawer_session_id") REFERENCES "public"."cash_drawer_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_tenders" ADD CONSTRAINT "settlement_tenders_drawer_session_fk" FOREIGN KEY ("cash_drawer_session_id") REFERENCES "public"."cash_drawer_sessions"("id") ON DELETE restrict ON UPDATE no action;