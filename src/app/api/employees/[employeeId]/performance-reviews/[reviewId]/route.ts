import { getDatabase } from "@/db";
import { requireApiPermission } from "@/modules/auth/guards";
import { updatePerformanceReview } from "@/modules/employees/services/review-service";
import {
  reviewParamsSchema,
  updateReviewSchema,
} from "@/modules/employees/validators/employee-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const PATCH = apiRoute<{ employeeId: string; reviewId: string }>(
  { module: "employees", operation: "update-performance-review" },
  async ({ request, params }) => {
    const actor = await requireApiPermission("hr.performance.manage");
    const ids = parseWith(reviewParamsSchema, params);
    const { expectedVersion, ...changes } = await parseJsonBody(request, updateReviewSchema);

    return { body: await updatePerformanceReview(getDatabase(), actor, { ...ids, expectedVersion, changes }) };
  },
);
