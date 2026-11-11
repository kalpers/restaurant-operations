CREATE TABLE "order_item_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"from_order_id" uuid NOT NULL,
	"to_order_id" uuid NOT NULL,
	"transfer_group_id" uuid NOT NULL,
	"moved_by_user_id" uuid NOT NULL,
	"moved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_item_transfers_different_orders" CHECK ("order_item_transfers"."from_order_id" <> "order_item_transfers"."to_order_id")
);
--> statement-breakpoint
ALTER TABLE "order_items" DROP CONSTRAINT "order_items_send_batch_order_fk";
--> statement-breakpoint
ALTER TABLE "order_item_transfers" ADD CONSTRAINT "order_item_transfers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_transfers" ADD CONSTRAINT "order_item_transfers_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_transfers" ADD CONSTRAINT "order_item_transfers_from_order_id_orders_id_fk" FOREIGN KEY ("from_order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_transfers" ADD CONSTRAINT "order_item_transfers_to_order_id_orders_id_fk" FOREIGN KEY ("to_order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_transfers" ADD CONSTRAINT "order_item_transfers_moved_by_user_id_users_id_fk" FOREIGN KEY ("moved_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_item_transfers_item_idx" ON "order_item_transfers" USING btree ("order_item_id","moved_at");--> statement-breakpoint
CREATE INDEX "order_item_transfers_group_idx" ON "order_item_transfers" USING btree ("transfer_group_id");--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_send_batch_fk" FOREIGN KEY ("send_batch_id") REFERENCES "public"."order_send_batches"("id") ON DELETE restrict ON UPDATE no action;