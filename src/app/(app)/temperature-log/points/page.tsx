import { eq } from "drizzle-orm";

import { TemperaturePointsManager } from "@/components/restaurant/temperature-points-manager";
import { PageHeader } from "@/components/ui/page-header";
import { getDatabase } from "@/db";
import { locationSettings } from "@/db/schema";
import type { TemperatureUnit } from "@/db/schema/food-safety";
import { requirePageActor } from "@/modules/auth/guards";
import { listTemperaturePoints } from "@/modules/restaurant/services/temperature-service";

/** Phase 36 (policy 6): the location's temperature check points. */
export default async function TemperaturePointsPage() {
  const { actor } = await requirePageActor("food-safety.manage");
  const database = getDatabase();
  const [points, [settings]] = await Promise.all([
    listTemperaturePoints(database, actor),
    database.select({ unit: locationSettings.temperatureUnit }).from(locationSettings).where(eq(locationSettings.locationId, actor.locationId)),
  ]);

  return (
    <>
      <PageHeader
        title="Temperature check points"
        description="Readings keep the safe range in force when they were taken; changing a range here applies from the next reading."
        breadcrumbs={[{ label: "Temperature log", href: "/temperature-log" }, { label: "Check points" }]}
      />
      <TemperaturePointsManager points={points} defaultUnit={(settings?.unit ?? "F") as TemperatureUnit} />
    </>
  );
}
