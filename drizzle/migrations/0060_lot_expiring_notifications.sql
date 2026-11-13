ALTER TABLE "notifications" DROP CONSTRAINT "notifications_type_valid";--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_link_matches_type";--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "inventory_lot_id" uuid;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_inventory_lot_id_inventory_lots_id_fk" FOREIGN KEY ("inventory_lot_id") REFERENCES "public"."inventory_lots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_type_valid" CHECK ("notifications"."notification_type" IN ('FOOD_READY', 'BAR_ORDER_READY', 'INVENTORY_LOW', 'SCHEDULE_PUBLISHED', 'SHIFT_CHANGED', 'TIME_OFF_APPROVED', 'TIME_OFF_DENIED', 'CERTIFICATION_EXPIRING', 'OVERTIME_APPROACHING', 'MISSED_CLOCK_OUT', 'LOT_EXPIRING'));--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_link_matches_type" CHECK (("notifications"."notification_type" <> 'SCHEDULE_PUBLISHED' OR "notifications"."schedule_period_id" IS NOT NULL)
        AND ("notifications"."notification_type" <> 'SHIFT_CHANGED' OR "notifications"."shift_swap_request_id" IS NOT NULL)
        AND ("notifications"."notification_type" NOT IN ('TIME_OFF_APPROVED', 'TIME_OFF_DENIED') OR "notifications"."time_off_request_id" IS NOT NULL)
        AND ("notifications"."notification_type" <> 'CERTIFICATION_EXPIRING' OR ("notifications"."employee_certification_id" IS NOT NULL AND "notifications"."dedupe_key" IS NOT NULL))
        AND ("notifications"."notification_type" NOT IN ('OVERTIME_APPROACHING', 'MISSED_CLOCK_OUT') OR ("notifications"."time_entry_id" IS NOT NULL AND "notifications"."dedupe_key" IS NOT NULL))
        AND ("notifications"."notification_type" <> 'LOT_EXPIRING' OR ("notifications"."inventory_lot_id" IS NOT NULL AND "notifications"."dedupe_key" IS NOT NULL)));