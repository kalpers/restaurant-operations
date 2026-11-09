import { ExpoBoard } from "@/components/kitchen/expo-board";
import { getDatabase } from "@/db";
import { requirePageActorWithAny } from "@/modules/auth/guards";
import { getExpoView } from "@/modules/kitchen/queries/kitchen-queries";

export default async function ExpoPage() {
  const { auth, location } = await requirePageActorWithAny(["kitchen.view", "bar.view"]);
  // Expo reads with every view scope the user holds here, not just the one that admitted them.
  const actor = {
    userId: auth.userId,
    organizationId: location.organizationId,
    locationId: location.locationId,
    permissions: new Set<string>(location.permissions),
  };
  const view = await getExpoView(getDatabase(), actor);

  return <ExpoBoard orders={view.orders} serverTime={view.serverTime} />;
}
