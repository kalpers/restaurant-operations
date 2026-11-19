import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { cashOutGiftCard } from "@/modules/settlements/services/gift-card-service";
import {
  cashOutGiftCardSchema,
  giftCardIdParamsSchema,
} from "@/modules/settlements/validators/settlement-validators";
import { apiRoute, parseWith } from "@/shared/http/api-route";

/** Phase 31 (policy 12): pays the whole balance out in cash. Retry-safe with the same key. */
export const POST = apiRoute<{ cardId: string }>(
  { module: "settlements", operation: "cash-out-gift-card" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(giftCardIdParamsSchema, params);
    const raw = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const body = parseWith(cashOutGiftCardSchema, {
      ...(raw ?? {}),
      idempotencyKey: request.headers.get("idempotency-key") ?? raw?.idempotencyKey,
    });

    return { body: await cashOutGiftCard(getDatabase(), actor, p.cardId, body), status: 201 };
  },
);
