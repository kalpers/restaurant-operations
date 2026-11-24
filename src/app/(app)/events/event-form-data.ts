import type { DatabaseExecutor } from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";
import { listItems } from "@/modules/menu/services/catalog-service";
import { listHostTables } from "@/modules/reservations/services/recommendation-service";

import type { EventFormTable } from "@/components/reservations/event-form";

/** Phase 36 (policy 7): what the event form offers: the tables in use, and active menu items. */
export async function loadEventFormData(executor: DatabaseExecutor, actor: Actor) {
  const tables: EventFormTable[] = (await listHostTables(executor, actor)).map((table) => ({
    id: table.id,
    tableNumber: table.tableNumber,
    capacity: table.capacity,
    areaId: table.areaId,
    areaName: table.areaName,
  }));
  const menuItems = actor.permissions.has("menu.view")
    ? (await listItems(executor, actor)).filter((item) => item.active).map((item) => ({ id: item.id, name: item.name }))
    : [];

  return { tables, menuItems };
}
