import { getDatabase } from "@/db";
import { requireApiPermission } from "@/modules/auth/guards";
import {
  addCertification,
  listCertifications,
} from "@/modules/employees/services/certification-service";
import {
  addCertificationSchema,
  employeeIdParamsSchema,
} from "@/modules/employees/validators/employee-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const GET = apiRoute<{ employeeId: string }>(
  { module: "employees", operation: "list-certifications" },
  async ({ params }) => {
    const actor = await requireApiPermission("hr.certifications.view");
    const { employeeId } = parseWith(employeeIdParamsSchema, params);

    return { body: { certifications: await listCertifications(getDatabase(), actor, employeeId) } };
  },
);

export const POST = apiRoute<{ employeeId: string }>(
  { module: "employees", operation: "add-certification" },
  async ({ request, params }) => {
    const actor = await requireApiPermission("hr.certifications.manage");
    const { employeeId } = parseWith(employeeIdParamsSchema, params);
    const input = await parseJsonBody(request, addCertificationSchema);

    return { body: await addCertification(getDatabase(), actor, employeeId, input), status: 201 };
  },
);
