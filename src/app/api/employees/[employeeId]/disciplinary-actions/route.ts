import { getDatabase } from "@/db";
import { requireApiPermission } from "@/modules/auth/guards";
import {
  addDisciplinaryAction,
  listDisciplinaryActions,
} from "@/modules/employees/services/review-service";
import {
  addDisciplinarySchema,
  employeeIdParamsSchema,
} from "@/modules/employees/validators/employee-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const GET = apiRoute<{ employeeId: string }>(
  { module: "employees", operation: "list-disciplinary-actions" },
  async ({ params }) => {
    const actor = await requireApiPermission("hr.disciplinary.view");
    const { employeeId } = parseWith(employeeIdParamsSchema, params);

    return { body: { actions: await listDisciplinaryActions(getDatabase(), actor, employeeId) } };
  },
);

export const POST = apiRoute<{ employeeId: string }>(
  { module: "employees", operation: "add-disciplinary-action" },
  async ({ request, params }) => {
    const actor = await requireApiPermission("hr.disciplinary.manage");
    const { employeeId } = parseWith(employeeIdParamsSchema, params);
    const input = await parseJsonBody(request, addDisciplinarySchema);

    return { body: await addDisciplinaryAction(getDatabase(), actor, employeeId, input), status: 201 };
  },
);
