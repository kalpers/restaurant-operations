import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import {
  createReservation,
  currentBusinessDate,
  listReservations,
} from "@/modules/reservations/services/reservation-service";
import {
  createReservationSchema,
  listReservationsQuerySchema,
} from "@/modules/reservations/validators/reservation-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const GET = apiRoute(
  { module: "reservations", operation: "list-reservations" },
  async ({ request }) => {
    const actor = await requireApiActor();
    const query = parseWith(
      listReservationsQuerySchema,
      Object.fromEntries(new URL(request.url).searchParams),
    );
    const database = getDatabase();
    const businessDate = await currentBusinessDate(database, actor);
    const reservations = await listReservations(database, actor, {
      fromBusinessDate: query.from ?? businessDate,
      toBusinessDate: query.to ?? query.from ?? businessDate,
      statuses: query.status,
    });

    return { body: { businessDate, reservations } };
  },
);

export const POST = apiRoute(
  { module: "reservations", operation: "create-reservation" },
  async ({ request }) => {
    const actor = await requireApiActor();
    const body = await parseJsonBody(request, createReservationSchema);

    return { body: await createReservation(getDatabase(), actor, body), status: 201 };
  },
);
