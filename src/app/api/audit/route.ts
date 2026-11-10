import { getDatabase } from "@/db";
import { auditFiltersSchema, listAuditEvents } from "@/modules/auditing";
import { requireApiPermission } from "@/modules/auth/guards";
import { apiRoute, parseWith } from "@/shared/http/api-route";

/** One page of the audit trail as JSON, newest first. Read-only; needs `audit.view`. */
export const GET = apiRoute(
  { module: "auditing", operation: "list-audit-events" },
  async ({ request }) => {
    const filters = parseWith(
      auditFiltersSchema,
      Object.fromEntries([...new URL(request.url).searchParams].filter(([, value]) => value !== "")),
    );
    const actor = await requireApiPermission("audit.view", filters.locationId);

    return {
      response: Response.json(await listAuditEvents(getDatabase(), actor, filters), {
        headers: { "Cache-Control": "private, no-store" },
      }),
    };
  },
);
