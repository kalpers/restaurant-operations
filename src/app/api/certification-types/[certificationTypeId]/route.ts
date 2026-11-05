import { getDatabase } from "@/db";
import { requireApiPermission } from "@/modules/auth/guards";
import { updateCertificationType } from "@/modules/employees/services/reference-service";
import {
  certificationTypeParamsSchema,
  updateCertificationTypeSchema,
} from "@/modules/employees/validators/employee-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const PATCH = apiRoute<{ certificationTypeId: string }>(
  { module: "employees", operation: "update-certification-type" },
  async ({ request, params }) => {
    const actor = await requireApiPermission("hr.certifications.manage");
    const { certificationTypeId } = parseWith(certificationTypeParamsSchema, params);
    const input = await parseJsonBody(request, updateCertificationTypeSchema);

    return { body: await updateCertificationType(getDatabase(), actor, { ...input, certificationTypeId }) };
  },
);
