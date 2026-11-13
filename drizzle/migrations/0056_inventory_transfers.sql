CREATE TABLE "inventory_transfer_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transfer_id" uuid NOT NULL,
	"inventory_item_id" uuid NOT NULL,
	"quantity" numeric(14, 4) NOT NULL,
	"unit_of_measure_id" uuid NOT NULL,
	"base_quantity" numeric(14, 4) NOT NULL,
	"unit_cost_sent" numeric(14, 4),
	"base_quantity_received" numeric(14, 4),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_transfer_lines_transfer_item_unique" UNIQUE("transfer_id","inventory_item_id"),
	CONSTRAINT "inventory_transfer_lines_quantity_positive" CHECK ("inventory_transfer_lines"."quantity" > 0 AND "inventory_transfer_lines"."base_quantity" > 0),
	CONSTRAINT "inventory_transfer_lines_received_range" CHECK ("inventory_transfer_lines"."base_quantity_received" IS NULL OR ("inventory_transfer_lines"."base_quantity_received" >= 0 AND "inventory_transfer_lines"."base_quantity_received" <= "inventory_transfer_lines"."base_quantity")),
	CONSTRAINT "inventory_transfer_lines_cost_non_negative" CHECK ("inventory_transfer_lines"."unit_cost_sent" IS NULL OR "inventory_transfer_lines"."unit_cost_sent" >= 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"from_location_id" uuid NOT NULL,
	"to_location_id" uuid NOT NULL,
	"sequence_number" integer NOT NULL,
	"transfer_number" text NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"notes" text,
	"created_by_user_id" uuid NOT NULL,
	"sent_at" timestamp with time zone,
	"sent_by_user_id" uuid,
	"received_at" timestamp with time zone,
	"received_by_user_id" uuid,
	"cancelled_at" timestamp with time zone,
	"cancelled_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "inventory_transfers_from_number_unique" UNIQUE("from_location_id","transfer_number"),
	CONSTRAINT "inventory_transfers_from_sequence_unique" UNIQUE("from_location_id","sequence_number"),
	CONSTRAINT "inventory_transfers_locations_differ" CHECK ("inventory_transfers"."from_location_id" <> "inventory_transfers"."to_location_id"),
	CONSTRAINT "inventory_transfers_status_valid" CHECK ("inventory_transfers"."status" IN ('DRAFT', 'SENT', 'RECEIVED', 'CANCELLED')),
	CONSTRAINT "inventory_transfers_sent_recorded" CHECK (("inventory_transfers"."status" IN ('SENT', 'RECEIVED')) = ("inventory_transfers"."sent_at" IS NOT NULL AND "inventory_transfers"."sent_by_user_id" IS NOT NULL)),
	CONSTRAINT "inventory_transfers_received_recorded" CHECK (("inventory_transfers"."status" = 'RECEIVED') = ("inventory_transfers"."received_at" IS NOT NULL AND "inventory_transfers"."received_by_user_id" IS NOT NULL)),
	CONSTRAINT "inventory_transfers_cancelled_recorded" CHECK (("inventory_transfers"."status" = 'CANCELLED') = ("inventory_transfers"."cancelled_at" IS NOT NULL AND "inventory_transfers"."cancelled_by_user_id" IS NOT NULL)),
	CONSTRAINT "inventory_transfers_notes_length" CHECK ("inventory_transfers"."notes" IS NULL OR length("inventory_transfers"."notes") <= 500)
);
--> statement-breakpoint
ALTER TABLE "inventory_transfer_lines" ADD CONSTRAINT "inventory_transfer_lines_transfer_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."inventory_transfers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transfer_lines" ADD CONSTRAINT "inventory_transfer_lines_item_fk" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."inventory_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transfer_lines" ADD CONSTRAINT "inventory_transfer_lines_unit_fk" FOREIGN KEY ("unit_of_measure_id") REFERENCES "public"."units_of_measure"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transfers" ADD CONSTRAINT "inventory_transfers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transfers" ADD CONSTRAINT "inventory_transfers_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transfers" ADD CONSTRAINT "inventory_transfers_sent_by_user_id_users_id_fk" FOREIGN KEY ("sent_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transfers" ADD CONSTRAINT "inventory_transfers_received_by_user_id_users_id_fk" FOREIGN KEY ("received_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transfers" ADD CONSTRAINT "inventory_transfers_cancelled_by_user_id_users_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transfers" ADD CONSTRAINT "inventory_transfers_from_org_fk" FOREIGN KEY ("from_location_id","organization_id") REFERENCES "public"."locations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transfers" ADD CONSTRAINT "inventory_transfers_to_org_fk" FOREIGN KEY ("to_location_id","organization_id") REFERENCES "public"."locations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inventory_transfers_from_status_idx" ON "inventory_transfers" USING btree ("from_location_id","status");--> statement-breakpoint
CREATE INDEX "inventory_transfers_to_status_idx" ON "inventory_transfers" USING btree ("to_location_id","status");