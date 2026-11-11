import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { fireCourse } from "@/modules/kitchen/services/course-fire-service";
import { fireCourseParamsSchema } from "@/modules/orders/validators/order-validators";
import { apiRoute, parseWith } from "@/shared/http/api-route";

/** Fires a held course of an order (Phase 17). Repeating it changes nothing. */
export const POST = apiRoute<{ orderId: string; course: string }>(
  { module: "kitchen", operation: "fire-course" },
  async ({ params }) => {
    const actor = await requireApiActor();
    const p = parseWith(fireCourseParamsSchema, params);

    return { body: await fireCourse(getDatabase(), actor, p.orderId, p.course) };
  },
);
