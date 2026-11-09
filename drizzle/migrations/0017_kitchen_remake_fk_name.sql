ALTER TABLE "kitchen_remakes" DROP CONSTRAINT "kitchen_remakes_idempotency_record_id_idempotency_records_id_fk";
--> statement-breakpoint
ALTER TABLE "kitchen_remakes" ADD CONSTRAINT "kitchen_remakes_idempotency_fk" FOREIGN KEY ("idempotency_record_id") REFERENCES "public"."idempotency_records"("id") ON DELETE restrict ON UPDATE no action;