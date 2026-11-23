-- Phase 35 (policy 4): which form each gift card code hash is in. Generated, then adjusted
-- before first apply: existing rows hold the plain SHA-256, so they are marked SHA256 through
-- a temporary default, which is then dropped so every new row must name its scheme.
ALTER TABLE "gift_cards" ADD COLUMN "code_hash_scheme" text DEFAULT 'SHA256' NOT NULL;--> statement-breakpoint
ALTER TABLE "gift_cards" ALTER COLUMN "code_hash_scheme" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "gift_cards" ADD CONSTRAINT "gift_cards_code_hash_scheme_valid" CHECK ("gift_cards"."code_hash_scheme" IN ('SHA256', 'HMAC_SHA256'));
