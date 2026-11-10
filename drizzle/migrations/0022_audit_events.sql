CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" bigint GENERATED ALWAYS AS IDENTITY (sequence name "audit_events_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"organization_id" uuid NOT NULL,
	"location_id" uuid,
	"actor_type" text NOT NULL,
	"actor_user_id" uuid,
	"actor_employee_id" uuid,
	"action" text NOT NULL,
	"category" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"request_id" text,
	"before" jsonb,
	"after" jsonb,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_events_sequence_unique" UNIQUE("sequence"),
	CONSTRAINT "audit_events_action_format" CHECK ("audit_events"."action" ~ '^[a-z]+[.][a-z-]+$'),
	CONSTRAINT "audit_events_category_valid" CHECK ("audit_events"."category" IN ('ACCESS', 'SECURITY', 'HR', 'SCHEDULING', 'ORDERS', 'MENU', 'INVENTORY', 'SETTLEMENTS', 'REPORTING')),
	CONSTRAINT "audit_events_actor_type_valid" CHECK ("audit_events"."actor_type" IN ('USER', 'SYSTEM')),
	CONSTRAINT "audit_events_actor_consistent" CHECK (("audit_events"."actor_type" = 'USER') = ("audit_events"."actor_user_id" IS NOT NULL)),
	CONSTRAINT "audit_events_request_id_length" CHECK (char_length("audit_events"."request_id") <= 100)
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_employee_id_employees_id_fk" FOREIGN KEY ("actor_employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_org_sequence_idx" ON "audit_events" USING btree ("organization_id","sequence");--> statement-breakpoint
CREATE INDEX "audit_events_location_sequence_idx" ON "audit_events" USING btree ("location_id","sequence");--> statement-breakpoint
CREATE INDEX "audit_events_entity_idx" ON "audit_events" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_events_actor_sequence_idx" ON "audit_events" USING btree ("actor_user_id","sequence");