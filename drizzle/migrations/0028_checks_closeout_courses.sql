DROP INDEX "kitchen_tickets_batch_station_unique";--> statement-breakpoint
ALTER TABLE "kitchen_tickets" ADD COLUMN "course_number" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "kitchen_tickets" ADD COLUMN "held_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "kitchen_tickets" ADD COLUMN "fired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "kitchen_tickets" ADD COLUMN "fired_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "kitchen_tickets" ADD CONSTRAINT "kitchen_tickets_fired_by_user_id_users_id_fk" FOREIGN KEY ("fired_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "kitchen_tickets_batch_station_course_unique" ON "kitchen_tickets" USING btree ("send_batch_id","prep_station_id","course_number") WHERE "kitchen_tickets"."remake_id" IS NULL;--> statement-breakpoint
CREATE INDEX "kitchen_tickets_order_held_idx" ON "kitchen_tickets" USING btree ("order_id","course_number") WHERE "kitchen_tickets"."fired_at" IS NULL;