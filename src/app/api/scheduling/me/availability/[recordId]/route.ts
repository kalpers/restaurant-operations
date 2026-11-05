import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { removeRecurringAvailability, updateRecurringAvailability } from "@/modules/scheduling/services/availability-service";
import { expectedVersionSchema, ownRecordParamsSchema, updateRecurringAvailabilitySchema } from "@/modules/scheduling/validators/scheduling-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const PATCH = apiRoute<{ recordId: string }>(
  { module: "scheduling", operation: "update-own-availability" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(ownRecordParamsSchema, params);
    const body = await parseJsonBody(request, updateRecurringAvailabilitySchema);
    const db = getDatabase();

    return { body: await updateRecurringAvailability(db, actor, { kind: "self" as const }, p.recordId, body) };
  },
);

export const DELETE = apiRoute<{ recordId: string }>(
  { module: "scheduling", operation: "remove-own-availability" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(ownRecordParamsSchema, params);
    const body = await parseJsonBody(request, expectedVersionSchema);
    const db = getDatabase();

    await removeRecurringAvailability(db, actor, { kind: "self" as const }, p.recordId, body);

    return {};
  },
);
