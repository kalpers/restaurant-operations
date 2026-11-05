import { getDatabase } from "@/db";
import { requireApiPermission } from "@/modules/auth/guards";
import { endAddress } from "@/modules/employees/services/personal-service";
import {
  addressParamsSchema,
  endAddressSchema,
} from "@/modules/employees/validators/employee-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const PATCH = apiRoute<{ employeeId: string; addressId: string }>(
  { module: "employees", operation: "end-address" },
  async ({ request, params }) => {
    const actor = await requireApiPermission("hr.personal.edit");
    const ids = parseWith(addressParamsSchema, params);
    const input = await parseJsonBody(request, endAddressSchema);

    await endAddress(getDatabase(), actor, { ...ids, ...input });

    return {};
  },
);
