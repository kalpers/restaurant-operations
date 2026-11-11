import { ActionButton } from "@/components/forms/action-button";
import { EntityForm } from "@/components/forms/entity-form";
import { StockBoardRefresh } from "@/components/menu/stock-board-refresh";
import { Badge } from "@/components/ui/badge";
import { Card, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { findDisplayNamesByUser } from "@/modules/employees/queries/employee-display-names";
import { getAuto86Setting, getStockBoard, type StockBoardItem } from "@/modules/menu/services/outage-service";

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

function portionsText(item: StockBoardItem): string | null {
  return item.portions === null ? null : `${item.portions} left`;
}

/**
 * The 86 board (Phase 19 policy A7). Everyone with menu access sees it; the actions show only
 * with `menu.availability.manage`, and every API checks that again.
 */
export default async function EightySixBoardPage() {
  const { location, actor } = await requirePageActor("menu.view");
  const database = getDatabase();
  const board = await getStockBoard(database, actor);
  const setting = await getAuto86Setting(database, actor);
  const names = await findDisplayNamesByUser(database, {
    organizationId: actor.organizationId,
    userIds: [
      ...board.items.flatMap((item) => [item.outage?.markedOutByUserId, item.override?.setByUserId]),
      ...board.restoredToday.map((entry) => entry.restoredByUserId),
    ].filter((id): id is string => typeof id === "string"),
  });
  const who = (userId: string) => names.get(userId) ?? "Staff";
  const canSetAuto = location.permissions.includes("locations.manage");
  const offSale = board.items.filter((item) => item.available && (item.state === "MANUAL_86" || item.state === "AUTO_86"));
  const low = board.items.filter((item) => item.runningLow && item.state === "SELLABLE");
  const sellAnyway = board.items.filter((item) => item.override !== null);
  const onSale = board.items.filter((item) => item.available && (item.state === "SELLABLE" || item.state === "SELL_ANYWAY"));

  return (
    <>
      <StockBoardRefresh />
      <PageHeader
        title="86 board"
        description={
          <>
            {location.locationName} · business date {board.businessDate} · auto-86 from stock is{" "}
            <strong>{board.auto86FromStock ? "on" : "off"}</strong>
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card aria-label="86'd now">
          <CardTitle>86&apos;d now ({offSale.length})</CardTitle>
          {offSale.length === 0 ? (
            <EmptyState title="Everything on the menu is on sale here." />
          ) : (
            <ul className="grid gap-3">
              {offSale.map((item) => (
                <li
                  key={item.menuItemId}
                  aria-label={`86'd ${item.name}`}
                  className="grid gap-1 border-b border-neutral-200 pb-3 last:border-0"
                >
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    {item.name}
                    <Badge tone={item.state === "MANUAL_86" ? "danger" : "warning"}>
                      {item.state === "MANUAL_86" ? "86'd" : "Out of stock"}
                    </Badge>
                  </p>
                  {item.outage ? (
                    <p className="text-sm text-neutral-700">
                      {item.outage.reason} · {who(item.outage.markedOutByUserId)} at {time(item.outage.markedOutAt)}
                    </p>
                  ) : (
                    <p className="text-sm text-neutral-700">
                      Not enough {item.limitingIngredient?.name ?? "stock"} for one more.
                    </p>
                  )}
                  {board.canManage && item.outage && (
                    <ActionButton
                      method="POST"
                      url={`/api/menu/outages/${item.outage.id}/restore`}
                      body={{ expectedVersion: item.outage.version }}
                      label={`Restore ${item.name}`}
                      successMessage={`${item.name} is back on sale.`}
                    />
                  )}
                  {board.canManage && !item.outage && item.state === "AUTO_86" && (
                    <EntityForm
                      method="POST"
                      url="/api/menu/stock-overrides"
                      hidden={{ menuItemId: item.menuItemId }}
                      fields={[{ name: "reason", label: "Why sell anyway?", required: true }]}
                      submitLabel={`Sell ${item.name} anyway today`}
                      successMessage={`${item.name} can be sold for the rest of today.`}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card aria-label="Running low">
          <CardTitle>Running low ({low.length})</CardTitle>
          {low.length === 0 ? (
            <EmptyState title="Nothing is down to its last few portions." />
          ) : (
            <ul className="grid gap-2">
              {low.map((item) => (
                <li key={item.menuItemId} className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{item.name}</span>
                  <Badge tone="warning">{portionsText(item)}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {sellAnyway.length > 0 && (
          <Card aria-label="Sell anyway today">
            <CardTitle>Sell anyway today ({sellAnyway.length})</CardTitle>
            <ul className="grid gap-3">
              {sellAnyway.map((item) => (
                <li key={item.menuItemId} className="grid gap-1">
                  <p className="font-medium">{item.name}</p>
                  <p className="text-sm text-neutral-700">
                    {item.override!.reason} · {who(item.override!.setByUserId)} at {time(item.override!.setAt)}
                  </p>
                  {board.canManage && (
                    <ActionButton
                      method="POST"
                      url={`/api/menu/stock-overrides/${item.override!.id}/clear`}
                      body={{ expectedVersion: item.override!.version }}
                      label={`Stop selling ${item.name} anyway`}
                      successMessage="Override cleared."
                    />
                  )}
                </li>
              ))}
            </ul>
          </Card>
        )}

        {board.restoredToday.length > 0 && (
          <Card aria-label="Restored today">
            <CardTitle>Restored today ({board.restoredToday.length})</CardTitle>
            <ul className="grid gap-1 text-sm">
              {board.restoredToday.map((entry) => (
                <li key={entry.outageId}>
                  {entry.name}: {entry.reason} · restored by {who(entry.restoredByUserId)} at {time(entry.restoredAt)}
                </li>
              ))}
            </ul>
          </Card>
        )}

        {board.canManage && (
          <Card aria-label="86 an item">
            <CardTitle>86 an item</CardTitle>
            {onSale.length === 0 ? (
              <EmptyState title="No item is on sale to 86." />
            ) : (
              <EntityForm
                method="POST"
                url="/api/menu/outages"
                resetOnSuccess
                fields={[
                  {
                    name: "menuItemId",
                    label: "Item",
                    type: "select",
                    required: true,
                    options: onSale.map((item) => ({
                      value: item.menuItemId,
                      label: portionsText(item) ? `${item.name} (${portionsText(item)})` : item.name,
                    })),
                  },
                  { name: "reason", label: "Reason", required: true },
                ]}
                submitLabel="86 item"
                successMessage="Item 86'd here."
              />
            )}
          </Card>
        )}

        {canSetAuto && (
          <Card aria-label="Auto-86 setting">
            <CardTitle>Auto-86 from stock</CardTitle>
            <p className="mb-3 text-sm text-neutral-700">
              When on, an item whose recipe can&apos;t be made once more from recorded stock comes off sale here,
              until stock comes in or a manager sells it anyway for the day.
            </p>
            <ActionButton
              method="PATCH"
              url="/api/menu/stock-settings"
              body={{ enabled: !setting.enabled, expectedVersion: setting.version }}
              label={setting.enabled ? "Turn auto-86 off" : "Turn auto-86 on"}
              successMessage={setting.enabled ? "Auto-86 is off." : "Auto-86 is on."}
            />
          </Card>
        )}
      </div>
    </>
  );
}
