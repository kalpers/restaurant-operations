import { getDatabase } from "@/db";
import { requireApiPermission } from "@/modules/auth/guards";
import { updateEmergencyContact } from "@/modules/employees/services/personal-service";
import {
  contactParamsSchema,
  emergencyContactSchema,
} from "@/modules/employees/validators/employee-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const PATCH = apiRoute<{ employeeId: string; contactId: string }>(
  { module: "employees", operation: "update-emergency-contact" },
  async ({ request, params }) => {
    const actor = await requireApiPermission("hr.personal.edit");
    const ids = parseWith(contactParamsSchema, params);
    const changes = await parseJsonBody(request, emergencyContactSchema);

    return { body: await updateEmergencyContact(getDatabase(), actor, { ...ids, changes }) };
  },
);
