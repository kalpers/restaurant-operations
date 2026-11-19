ALTER TABLE "price_period_items" DROP CONSTRAINT "price_period_items_period_org_fk";
--> statement-breakpoint
ALTER TABLE "price_period_items" ADD CONSTRAINT "price_period_items_period_org_fk" FOREIGN KEY ("price_period_id","organization_id") REFERENCES "public"."price_periods"("id","organization_id") ON DELETE restrict ON UPDATE no action;