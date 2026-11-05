import { getDatabase } from "@/db";
import { requireApiPermission } from "@/modules/auth/guards";
import {
  getEmployeePersonal,
  updatePersonalContact,
} from "@/modules/employees/services/personal-service";
import {
  employeeIdParamsSchema,
  updatePersonalContactSchema,
} from "@/modules/employees/validators/employee-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const GET = apiRoute<{ employeeId: string }>(
  { module: "employees", operation: "get-employee-personal" },
  async ({ params }) => {
    const actor = await requireApiPermission("hr.personal.view");
    const { employeeId } = parseWith(employeeIdParamsSchema, params);

    return { body: await getEmployeePersonal(getDatabase(), actor, employeeId) };
  },
);

export const PATCH = apiRoute<{ employeeId: string }>(
  { module: "employees", operation: "update-employee-personal" },
  async ({ request, params }) => {
    const actor = await requireApiPermission("hr.personal.edit");
    const { employeeId } = parseWith(employeeIdParamsSchema, params);
    const input = await parseJsonBody(request, updatePersonalContactSchema);

    return { body: await updatePersonalContact(getDatabase(), actor, employeeId, input) };
  },
);
