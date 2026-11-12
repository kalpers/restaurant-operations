import { z } from "zod";

import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { recordOrderAllergy } from "@/modules/orders/services/order-allergy-service";
import { orderAllergySchema } from "@/modules/orders/validators/order-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

const paramsSchema = z.object({ orderId: z.uuid() });

/** Add or change an allergy on a check with no guest party: takeout or a bar tab (Phase 21, policy 8). */
export const POST = apiRoute<{ orderId: string }>(
  { module: "orders", operation: "record-order-allergy" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const { orderId } = parseWith(paramsSchema, params);
    const body = await parseJsonBody(request, orderAllergySchema);

    return { body: await recordOrderAllergy(getDatabase(), actor, { ...body, orderId }) };
  },
);
