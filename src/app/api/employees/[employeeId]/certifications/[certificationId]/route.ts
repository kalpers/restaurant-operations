import { getDatabase } from "@/db";
import { requireApiPermission } from "@/modules/auth/guards";
import { updateCertification } from "@/modules/employees/services/certification-service";
import {
  certificationParamsSchema,
  updateCertificationSchema,
} from "@/modules/employees/validators/employee-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const PATCH = apiRoute<{ employeeId: string; certificationId: string }>(
  { module: "employees", operation: "update-certification" },
  async ({ request, params }) => {
    const actor = await requireApiPermission("hr.certifications.manage");
    const ids = parseWith(certificationParamsSchema, params);
    const details = await parseJsonBody(request, updateCertificationSchema);

    await updateCertification(getDatabase(), actor, { ...ids, details });

    return {};
  },
);
