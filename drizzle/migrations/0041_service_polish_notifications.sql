ALTER TABLE "notifications" DROP CONSTRAINT "notifications_type_valid";--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "schedule_period_id" uuid;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "shift_swap_request_id" uuid;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "time_off_request_id" uuid;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "employee_certification_id" uuid;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "time_entry_id" uuid;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_schedule_period_id_schedule_periods_id_fk" FOREIGN KEY ("schedule_period_id") REFERENCES "public"."schedule_periods"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_shift_swap_request_id_shift_swap_requests_id_fk" FOREIGN KEY ("shift_swap_request_id") REFERENCES "public"."shift_swap_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_time_off_request_id_time_off_requests_id_fk" FOREIGN KEY ("time_off_request_id") REFERENCES "public"."time_off_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_time_entry_id_time_entries_id_fk" FOREIGN KEY ("time_entry_id") REFERENCES "public"."time_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_certification_fk" FOREIGN KEY ("employee_certification_id") REFERENCES "public"."employee_certifications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_dedupe_recipient_unique" UNIQUE("dedupe_key","recipient_user_id");--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_link_matches_type" CHECK (("notifications"."notification_type" <> 'SCHEDULE_PUBLISHED' OR "notifications"."schedule_period_id" IS NOT NULL)
        AND ("notifications"."notification_type" <> 'SHIFT_CHANGED' OR "notifications"."shift_swap_request_id" IS NOT NULL)
        AND ("notifications"."notification_type" NOT IN ('TIME_OFF_APPROVED', 'TIME_OFF_DENIED') OR "notifications"."time_off_request_id" IS NOT NULL)
        AND ("notifications"."notification_type" <> 'CERTIFICATION_EXPIRING' OR ("notifications"."employee_certification_id" IS NOT NULL AND "notifications"."dedupe_key" IS NOT NULL))
        AND ("notifications"."notification_type" NOT IN ('OVERTIME_APPROACHING', 'MISSED_CLOCK_OUT') OR ("notifications"."time_entry_id" IS NOT NULL AND "notifications"."dedupe_key" IS NOT NULL)));--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_type_valid" CHECK ("notifications"."notification_type" IN ('FOOD_READY', 'BAR_ORDER_READY', 'INVENTORY_LOW', 'SCHEDULE_PUBLISHED', 'SHIFT_CHANGED', 'TIME_OFF_APPROVED', 'TIME_OFF_DENIED', 'CERTIFICATION_EXPIRING', 'OVERTIME_APPROACHING', 'MISSED_CLOCK_OUT'));