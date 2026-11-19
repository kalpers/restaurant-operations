import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { listGiftCards, sellGiftCard } from "@/modules/settlements/services/gift-card-service";
import { sellGiftCardSchema } from "@/modules/settlements/validators/settlement-validators";
import { apiRoute, parseWith } from "@/shared/http/api-route";

/** Phase 31: the most recent cards, for managers. */
export const GET = apiRoute({ module: "settlements", operation: "list-gift-cards" }, async () => {
  const actor = await requireApiActor();

  return { body: { cards: await listGiftCards(getDatabase(), actor) } };
});

/**
 * Sells a new card (no code) or reloads one (its code). Retry-safe with the same key. A new
 * card's code is in this response only, never stored (amendment 1), so it isn't cached.
 */
export const POST = apiRoute({ module: "settlements", operation: "sell-gift-card" }, async ({ request }) => {
  const actor = await requireApiActor();
  const raw = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const body = parseWith(sellGiftCardSchema, {
    ...(raw ?? {}),
    idempotencyKey: request.headers.get("idempotency-key") ?? raw?.idempotencyKey,
  });
  const result = await sellGiftCard(getDatabase(), actor, body);

  return { response: Response.json(result, { status: 201, headers: { "Cache-Control": "no-store" } }) };
});
