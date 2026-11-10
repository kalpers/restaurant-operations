import { getDatabase } from "@/db";
import { requireApiPermission } from "@/modules/auth/guards";
import { getSystemHealth } from "@/modules/auth/services/system-health-service";
import { apiRoute } from "@/shared/http/api-route";

export const GET = apiRoute({ module: "auth", operation: "system-health" }, async () => {
  const actor = await requireApiPermission("admin.system.view");

  return { body: await getSystemHealth(getDatabase(), actor) };
});
