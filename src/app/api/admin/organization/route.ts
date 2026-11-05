import { getDatabase } from "@/db";
import { requireApiPermission } from "@/modules/auth/guards";
import { updateOrganization } from "@/modules/organization/services/organization-service";
import { updateOrganizationSchema } from "@/modules/organization/validators/organization-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

export const PATCH = apiRoute(
  { module: "organization", operation: "update-organization" },
  async ({ request }) => {
    const actor = await requireApiPermission("organization.manage");
    const input = await parseJsonBody(request, updateOrganizationSchema);

    return {
      body: await updateOrganization(
        getDatabase(),
        actor.organizationId,
        input,
      ),
    };
  },
);
