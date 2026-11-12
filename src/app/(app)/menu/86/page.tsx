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
import {
  getAuto86Setting,
  getStockBoard,
  type BoardOutage,
  type StockBoardItem,
} from "@/modules/menu/services/outage-service";
import { getLocationTimeZone } from "@/modules/organization/services/organization-service";
import { formatInstant } from "@/shared/time/format-instant";

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
  const timeZone = await getLocationTimeZone(database, location.locationId);
  const time = (iso: string) => formatInstant(iso, timeZone, "time");
  const names = await findDisplayNamesByUser(database, {
    organizationId: actor.organizationId,
    userIds: [
      ...board.items.flatMap((item) => [item.outage?.markedOutByUserId, item.override?.setByUserId]),
      ...board.restoredToday.map((entry) => entry.restoredByUserId),
      ...[...board.scheduled, ...board.endedToday, ...board.modifiersOut].map((entry) => entry.markedOutByUserId),
    ].filter((id): id is string => typeof id === "string"),
  });
  const who = (userId: string) => names.get(userId) ?? "Staff";
  const dayTime = (iso: string) => formatInstant(iso, timeZone);
  const until = (endsAt: string | null) => (endsAt ? ` · until ${dayTime(endsAt)}` : "");
  const restoreUrl = (entry: BoardOutage) =>
    entry.kind === "ITEM" ? `/api/menu/outages/${entry.outageId}/restore` : `/api/menu/modifier-outages/${entry.outageId}/restore`;
  // Phase 20 (policy 4): a 86 may start later and end at a time or at close.
  const windowFields = [
    { name: "startsAt", label: "Starts (location time; blank is now)", type: "datetime-local" as const },
    { name: "endsAt", label: "Ends (location time; blank is until restored)", type: "datetime-local" as const },
    { name: "untilClose", label: "Until close (the business-day cutoff)", type: "checkbox" as const },
  ];
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
                      {until(item.outage.endsAt)}
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

        {board.modifiersOut.length > 0 && (
          <Card aria-label="Modifiers 86'd now">
            <CardTitle>Modifiers 86&apos;d now ({board.modifiersOut.length})</CardTitle>
            <ul className="grid gap-3">
              {board.modifiersOut.map((entry) => (
                <OutageRow
                  key={entry.outageId}
                  entry={entry}
                  text={`${entry.reason} · ${who(entry.markedOutByUserId)}${until(entry.endsAt)}`}
                  restoreUrl={board.canManage ? restoreUrl(entry) : null}
                  restoreLabel={`Restore ${entry.name}`}
                />
              ))}
            </ul>
          </Card>
        )}

        {board.scheduled.length > 0 && (
          <Card aria-label="Scheduled 86">
            <CardTitle>Scheduled ({board.scheduled.length})</CardTitle>
            <ul className="grid gap-3">
              {board.scheduled.map((entry) => (
                <OutageRow
                  key={entry.outageId}
                  entry={entry}
                  text={`From ${dayTime(entry.startsAt)}${until(entry.endsAt)} · ${entry.reason} · ${who(entry.markedOutByUserId)}`}
                  restoreUrl={board.canManage ? restoreUrl(entry) : null}
                  restoreLabel={`Cancel the 86 of ${entry.name}`}
                />
              ))}
            </ul>
          </Card>
        )}

        {board.endedToday.length > 0 && (
          <Card aria-label="Ended today">
            <CardTitle>Ended today ({board.endedToday.length})</CardTitle>
            <ul className="grid gap-1 text-sm">
              {board.endedToday.map((entry) => (
                <li key={entry.outageId}>
                  {entry.name}: {entry.reason} · ended at {time(entry.endsAt!)}
                </li>
              ))}
            </ul>
          </Card>
        )}

        <Card aria-label="Running low">
          <CardTitle>Running low ({low.length})</CardTitle>
          <p className="mb-2 text-sm text-neutral-600">1 to {board.runningLowPortions} portions left.</p>
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
                  ...windowFields,
                ]}
                submitLabel="86 item"
                successMessage="Item 86'd here."
              />
            )}
          </Card>
        )}

        {board.canManage && board.modifierChoices.length > 0 && (
          <Card aria-label="86 a modifier">
            <CardTitle>86 a modifier</CardTitle>
            <p className="mb-3 text-sm text-neutral-700">
              A 86&apos;d modifier can&apos;t be chosen here. An item that needs a choice from a group with none left
              comes off sale too.
            </p>
            <EntityForm
              method="POST"
              url="/api/menu/modifier-outages"
              resetOnSuccess
              fields={[
                {
                  name: "modifierId",
                  label: "Modifier",
                  type: "select",
                  required: true,
                  options: board.modifierChoices.map((modifier) => ({ value: modifier.id, label: modifier.name })),
                },
                { name: "reason", label: "Reason", required: true },
                ...windowFields,
              ]}
              submitLabel="86 modifier"
              successMessage="Modifier 86'd here."
            />
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
            <div className="mt-4">
              <EntityForm
                method="PATCH"
                url="/api/menu/stock-settings"
                hidden={{ enabled: setting.enabled, expectedVersion: setting.version }}
                fields={[
                  {
                    name: "runningLowPortions",
                    label: "Running low at (portions left)",
                    type: "number",
                    required: true,
                    defaultValue: setting.runningLowPortions,
                  },
                ]}
                submitLabel="Save threshold"
                successMessage="Running-low threshold saved."
              />
            </div>
          </Card>
        )}
      </div>
    </>
  );
}

function OutageRow({
  entry,
  text,
  restoreUrl,
  restoreLabel,
}: {
  entry: BoardOutage;
  text: string;
  restoreUrl: string | null;
  restoreLabel: string;
}) {
  return (
    <li aria-label={`86 ${entry.name}`} className="grid gap-1 border-b border-neutral-200 pb-3 last:border-0">
      <p className="flex flex-wrap items-center gap-2 font-medium">
        {entry.name}
        <Badge tone="neutral">{entry.kind === "ITEM" ? "Item" : "Modifier"}</Badge>
      </p>
      <p className="text-sm text-neutral-700">{text}</p>
      {restoreUrl && (
        <ActionButton
          method="POST"
          url={restoreUrl}
          body={{ expectedVersion: entry.version }}
          label={restoreLabel}
          successMessage={`${entry.name} is back.`}
        />
      )}
    </li>
  );
}
