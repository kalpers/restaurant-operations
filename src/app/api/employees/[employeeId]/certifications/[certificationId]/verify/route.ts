import { getDatabase } from "@/db";
import { requireApiPermission } from "@/modules/auth/guards";
import { verifyCertification } from "@/modules/employees/services/certification-service";
import { certificationParamsSchema } from "@/modules/employees/validators/employee-validators";
import { apiRoute, parseWith } from "@/shared/http/api-route";

export const PUT = apiRoute<{ employeeId: string; certificationId: string }>(
  { module: "employees", operation: "verify-certification" },
  async ({ params }) => {
    const actor = await requireApiPermission("hr.certifications.manage");
    const ids = parseWith(certificationParamsSchema, params);

    await verifyCertification(getDatabase(), actor, ids);

    return {};
  },
);
