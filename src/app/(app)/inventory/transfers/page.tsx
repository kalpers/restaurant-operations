import { formatQuantity } from "@/components/inventory/format";
import { InventoryTabs } from "@/components/inventory/inventory-tabs";
import { TransferBoard, type TransferView } from "@/components/inventory/transfer-board";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { listOnHand } from "@/modules/inventory/queries/stock-queries";
import { actorHolds } from "@/modules/inventory/services/access";
import { listUnitChoices } from "@/modules/inventory/services/item-service";
import { listTransfers } from "@/modules/inventory/services/transfer-service";
import { listOrganizationLocations } from "@/modules/organization/services/location-lifecycle-service";

/**
 * Phase 23 (policies 10–15): transfers to and from this location. Stock that has been sent
 * and not yet received is in transit and shown here at both ends.
 */
export default async function TransfersPage() {
  const { auth, location, actor } = await requirePageActor("inventory.view");
  const database = getDatabase();
  const [stocked, units, transfers, everyLocation] = await Promise.all([
    listOnHand(database, actor),
    listUnitChoices(database, actor),
    listTransfers(database, actor),
    listOrganizationLocations(database, actor.organizationId),
  ]);
  const items = stocked
    .filter((row) => row.itemActive && row.stockedActive)
    .map((row) => ({
      value: row.inventoryItemId,
      label: `${row.name} (${formatQuantity(row.quantityOnHand)} ${row.baseUnitCode} on hand)`,
    }));
  const destinations = everyLocation
    .filter((entry) => entry.active && entry.id !== location.locationId)
    .map((entry) => ({
      value: entry.id,
      label: entry.name,
      canReceiveThere: auth.locations.some(
        (granted) => granted.locationId === entry.id && granted.permissions.includes("inventory.transfer"),
      ),
    }));

  return (
    <>
      <h1 className="mb-1 text-2xl font-semibold">Transfers</h1>
      <p className="mb-4 text-neutral-600">{location.locationName}</p>
      <InventoryTabs current="/inventory/transfers" permissions={location.permissions} />
      <TransferBoard
        transfers={transfers.map(
          (transfer): TransferView => ({
            ...transfer,
            sentAt: transfer.sentAt?.toISOString() ?? null,
            receivedAt: transfer.receivedAt?.toISOString() ?? null,
          }),
        )}
        items={items}
        units={units.map((unit) => ({ value: unit.id, label: unit.code }))}
        destinations={destinations}
        locationNames={Object.fromEntries(everyLocation.map((entry) => [entry.id, entry.name]))}
        canTransfer={actorHolds(actor, "inventory.transfer")}
      />
    </>
  );
}
