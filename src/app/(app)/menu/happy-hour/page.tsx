import { ActionButton } from "@/components/forms/action-button";
import { DAY_NAMES, ORDER_TYPE_LABELS, PricePeriodEditor } from "@/components/menu/price-period-editor";
import { Badge } from "@/components/ui/badge";
import { Card, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { formatMoney } from "@/components/format/money";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { listItems } from "@/modules/menu/services/catalog-service";
import { listPricePeriods } from "@/modules/menu/services/price-period-service";

/**
 * Phase 28 price periods ("happy hour"), policies 2 to 5. Viewing needs `menu.pricing.view`;
 * the forms show only with `menu.pricing.edit`, and every API checks again.
 */
export default async function HappyHourPage() {
  const { location, actor } = await requirePageActor("menu.pricing.view");
  const database = getDatabase();
  const periods = await listPricePeriods(database, actor);
  const canEdit = actor.permissions.has("menu.pricing.edit");
  const items = canEdit
    ? (await listItems(database, actor))
        .filter((item) => item.active)
        .map((item) => ({ id: item.id, name: item.name, code: item.code }))
    : [];

  return (
    <>
      <PageHeader
        title="Happy hour"
        description={`${location.locationName}: fixed prices for chosen items at set days and times. The price is decided when an item is sent.`}
      />

      {canEdit ? (
        <Card className="mb-8">
          <CardTitle>Add a price period</CardTitle>
          <PricePeriodEditor menuItems={items} />
        </Card>
      ) : null}

      {periods.length === 0 ? (
        <EmptyState title="No price periods yet">Items sell at their regular price.</EmptyState>
      ) : (
        <ul className="grid gap-4">
          {periods.map((period) => (
            <li key={period.id}>
              <Card aria-label={`Price period ${period.name}`}>
                <CardTitle>
                  {period.name}{" "}
                  <Badge tone={period.active ? "success" : "neutral"}>{period.active ? "Active" : "Inactive"}</Badge>
                </CardTitle>
                <p className="mb-2 text-sm text-neutral-700">
                  {period.daysOfWeek.map((day) => DAY_NAMES[day]).join(", ")} · {period.startTime} to {period.endTime} ·{" "}
                  {period.orderTypes === null
                    ? "All order types"
                    : period.orderTypes.map((type) => ORDER_TYPE_LABELS[type] ?? type).join(", ")}
                  {period.firstDate ? ` · from ${period.firstDate}` : ""}
                  {period.lastDate ? ` · until ${period.lastDate}` : ""}
                </p>
                <ul className="mb-3 text-sm">
                  {period.items.map((item) => (
                    <li key={item.menuItemId}>
                      {item.name}: {formatMoney(item.price)}
                    </li>
                  ))}
                </ul>
                {canEdit && period.active ? (
                  <>
                    <details className="mb-3">
                      <summary className="cursor-pointer text-sm font-medium text-brand-700">Edit</summary>
                      <div className="mt-3">
                        <PricePeriodEditor
                          menuItems={items}
                          period={{
                            ...period,
                            items: period.items.map((item) => ({ menuItemId: item.menuItemId, price: item.price })),
                          }}
                        />
                      </div>
                    </details>
                    <ActionButton
                      method="POST"
                      url={`/api/menu/price-periods/${period.id}/deactivate`}
                      body={{ expectedVersion: period.version }}
                      label="Deactivate"
                      variant="danger"
                      successMessage="Price period deactivated."
                      confirm={{
                        title: `Deactivate ${period.name}?`,
                        body: "Its items go back to their regular price. Sent items keep the price they sold at.",
                        confirmLabel: "Deactivate",
                      }}
                    />
                  </>
                ) : null}
              </Card>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
