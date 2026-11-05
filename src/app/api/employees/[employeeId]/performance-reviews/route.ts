import { getDatabase } from "@/db";
import { requireApiPermission } from "@/modules/auth/guards";
import {
  addPerformanceReview,
  listPerformanceReviews,
} from "@/modules/employees/services/review-service";
import {
  addReviewSchema,
  employeeIdParamsSchema,
} from "@/modules/employees/validators/employee-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const GET = apiRoute<{ employeeId: string }>(
  { module: "employees", operation: "list-performance-reviews" },
  async ({ params }) => {
    const actor = await requireApiPermission("hr.performance.view");
    const { employeeId } = parseWith(employeeIdParamsSchema, params);

    return { body: { reviews: await listPerformanceReviews(getDatabase(), actor, employeeId) } };
  },
);

export const POST = apiRoute<{ employeeId: string }>(
  { module: "employees", operation: "add-performance-review" },
  async ({ request, params }) => {
    const actor = await requireApiPermission("hr.performance.manage");
    const { employeeId } = parseWith(employeeIdParamsSchema, params);
    const input = await parseJsonBody(request, addReviewSchema);

    return { body: await addPerformanceReview(getDatabase(), actor, employeeId, input), status: 201 };
  },
);
