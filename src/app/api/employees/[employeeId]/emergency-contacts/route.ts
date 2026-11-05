import { getDatabase } from "@/db";
import { requireApiPermission } from "@/modules/auth/guards";
import { addEmergencyContact } from "@/modules/employees/services/personal-service";
import {
  emergencyContactSchema,
  employeeIdParamsSchema,
} from "@/modules/employees/validators/employee-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const POST = apiRoute<{ employeeId: string }>(
  { module: "employees", operation: "add-emergency-contact" },
  async ({ request, params }) => {
    const actor = await requireApiPermission("hr.personal.edit");
    const { employeeId } = parseWith(employeeIdParamsSchema, params);
    const input = await parseJsonBody(request, emergencyContactSchema);

    return { body: await addEmergencyContact(getDatabase(), actor, employeeId, input), status: 201 };
  },
);
