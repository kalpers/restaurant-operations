import { getDatabase } from "@/db";
import { requireApiPermission } from "@/modules/auth/guards";
import {
  createCertificationType,
  listCertificationTypes,
} from "@/modules/employees/services/reference-service";
import { createCertificationTypeSchema } from "@/modules/employees/validators/employee-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

export const GET = apiRoute(
  { module: "employees", operation: "list-certification-types" },
  async () => {
    const actor = await requireApiPermission("hr.certifications.view");

    return { body: { certificationTypes: await listCertificationTypes(getDatabase(), actor) } };
  },
);

export const POST = apiRoute(
  { module: "employees", operation: "create-certification-type" },
  async ({ request }) => {
    const actor = await requireApiPermission("hr.certifications.manage");
    const input = await parseJsonBody(request, createCertificationTypeSchema);

    return { body: await createCertificationType(getDatabase(), actor, input), status: 201 };
  },
);
