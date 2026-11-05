import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { addRecurringAvailability, getAvailability } from "@/modules/scheduling/services/availability-service";
import { recurringAvailabilitySchema } from "@/modules/scheduling/validators/scheduling-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

export const GET = apiRoute(
  { module: "scheduling", operation: "get-own-availability" },
  async () => {
    const actor = await requireApiActor();
    const db = getDatabase();

    return { body: await getAvailability(db, actor, { kind: "self" as const }) };
  },
);

export const POST = apiRoute(
  { module: "scheduling", operation: "add-own-availability" },
  async ({ request }) => {
    const actor = await requireApiActor();
    const body = await parseJsonBody(request, recurringAvailabilitySchema);
    const db = getDatabase();

    return { body: await addRecurringAvailability(db, actor, { kind: "self" as const }, body), status: 201 };
  },
);
