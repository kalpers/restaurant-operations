import { getDatabase } from "@/db";
import { requireApiPermission } from "@/modules/auth/guards";
import { updateDisciplinaryAction } from "@/modules/employees/services/review-service";
import {
  disciplinaryParamsSchema,
  updateDisciplinarySchema,
} from "@/modules/employees/validators/employee-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const PATCH = apiRoute<{ employeeId: string; actionId: string }>(
  { module: "employees", operation: "update-disciplinary-action" },
  async ({ request, params }) => {
    const actor = await requireApiPermission("hr.disciplinary.manage");
    const ids = parseWith(disciplinaryParamsSchema, params);
    const { expectedVersion, ...changes } = await parseJsonBody(request, updateDisciplinarySchema);

    return { body: await updateDisciplinaryAction(getDatabase(), actor, { ...ids, expectedVersion, changes }) };
  },
);
