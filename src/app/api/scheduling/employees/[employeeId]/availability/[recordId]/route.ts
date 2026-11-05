import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { removeRecurringAvailability, updateRecurringAvailability } from "@/modules/scheduling/services/availability-service";
import { expectedVersionSchema, recordParamsSchema, updateRecurringAvailabilitySchema } from "@/modules/scheduling/validators/scheduling-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const PATCH = apiRoute<{ employeeId: string; recordId: string }>(
  { module: "scheduling", operation: "update-availability" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(recordParamsSchema, params);
    const body = await parseJsonBody(request, updateRecurringAvailabilitySchema);
    const db = getDatabase();

    return { body: await updateRecurringAvailability(db, actor, { kind: "employee" as const, employeeId: p.employeeId }, p.recordId, body) };
  },
);

export const DELETE = apiRoute<{ employeeId: string; recordId: string }>(
  { module: "scheduling", operation: "remove-availability" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(recordParamsSchema, params);
    const body = await parseJsonBody(request, expectedVersionSchema);
    const db = getDatabase();

    await removeRecurringAvailability(db, actor, { kind: "employee" as const, employeeId: p.employeeId }, p.recordId, body);

    return {};
  },
);
