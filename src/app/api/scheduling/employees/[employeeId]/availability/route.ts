import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { addRecurringAvailability, getAvailability } from "@/modules/scheduling/services/availability-service";
import { employeeIdParamsSchema, recurringAvailabilitySchema } from "@/modules/scheduling/validators/scheduling-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const GET = apiRoute<{ employeeId: string }>(
  { module: "scheduling", operation: "get-availability" },
  async ({ params }) => {
    const actor = await requireApiActor();
    const p = parseWith(employeeIdParamsSchema, params);
    const db = getDatabase();

    return { body: await getAvailability(db, actor, { kind: "employee" as const, employeeId: p.employeeId }) };
  },
);

export const POST = apiRoute<{ employeeId: string }>(
  { module: "scheduling", operation: "add-availability" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(employeeIdParamsSchema, params);
    const body = await parseJsonBody(request, recurringAvailabilitySchema);
    const db = getDatabase();

    return { body: await addRecurringAvailability(db, actor, { kind: "employee" as const, employeeId: p.employeeId }, body), status: 201 };
  },
);
