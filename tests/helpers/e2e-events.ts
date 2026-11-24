import { randomUUID } from "node:crypto";

import { getDatabase } from "../../src/db";
import { restaurantAreas } from "../../src/db/schema";
import { getUserAuthContext, requirePermission } from "../../src/modules/auth/services/permission-service";
import { createTable } from "../../src/modules/restaurant/services/table-service";

import type { BriefingsSetup } from "./e2e-briefings";

/** Phase 36 E2E: a private dining room with two tables at the spec's own location. */
export async function createEventSpace(setup: BriefingsSetup): Promise<{ areaName: string; tableNumbers: string[] }> {
  const database = getDatabase();
  const areaName = `Private room ${setup.suffix}`;
  const [area] = await database
    .insert(restaurantAreas)
    .values({ locationId: setup.locationId, code: `PDR_${randomUUID().slice(0, 8).toUpperCase()}`, name: areaName, areaType: "DINING" })
    .returning({ id: restaurantAreas.id });
  const context = await getUserAuthContext(database, setup.owner.id);
  const owner = requirePermission(context!, { permission: "restaurant.tables.manage", locationId: setup.locationId });
  const tableNumbers = ["P1", "P2"];

  for (const tableNumber of tableNumbers) {
    await createTable(database, owner, {
      restaurantAreaId: area!.id,
      tableNumber,
      name: null,
      capacity: 8,
      minimumCapacity: null,
      sortOrder: null,
    });
  }

  return { areaName, tableNumbers };
}
