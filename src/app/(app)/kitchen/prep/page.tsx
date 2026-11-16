import Link from "next/link";

import { formatQuantity } from "@/components/inventory/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { Table, TableFrame, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { getDatabase } from "@/db";
import { requirePageActorWithAny } from "@/modules/auth/guards";
import { readForecastInputs } from "@/modules/scheduling/queries/forecast-inputs";
import { businessDateOf } from "@/shared/time/business-date-service";
import { addDays } from "@/shared/time/zoned-time";
import { getPrepList } from "@/workflows/forecast-items/forecast-items";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Phase 25 prep list (D5, policies 9-10): per station, the portions the forecast expects for a
 * business date, the modifiers guests usually ask for, and the ingredients those portions take.
 * Worked out when opened; nothing is stored. Stations follow the viewer's kitchen and bar access.
 */
export default async function PrepListPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { location, actor } = await requirePageActorWithAny(["kitchen.view", "bar.view"]);
  const database = getDatabase();
  const params = await searchParams;
  const { clock } = await readForecastInputs(database, actor.locationId);
  const today = businessDateOf(new Date(), clock);
  const last = addDays(today, 6);
  const requested = typeof params.date === "string" && DATE_PATTERN.test(params.date) ? params.date : today;
  const businessDate = requested >= today && requested <= last ? requested : today;
  const list = await getPrepList(database, actor, { businessDate });
  const stationParam = typeof params.station === "string" ? params.station : null;
  const shown = list.stations.filter((station) => stationParam === null || station.id === stationParam);

  return (
    <>
      <PageHeader
        title="Prep list"
        description={
          <>
            {location.locationName} · business date {businessDate}. Expected portions from the same weekday in recent
            weeks, rounded up{businessDate === today ? ", less what has already been sent today" : ""}.
          </>
        }
      />

      <form method="get" aria-label="Prep list date" className="mb-4 flex flex-wrap items-end gap-3 print:hidden">
        <Field label="Business date">
          <Input type="date" name="date" defaultValue={businessDate} min={today} max={last} />
        </Field>
        {stationParam && <input type="hidden" name="station" value={stationParam} />}
        <Button type="submit" variant="secondary">
          Show
        </Button>
      </form>

      {requested !== businessDate && (
        <p role="status" className="mb-4 text-sm text-warning-900">
          Prep lists cover today and the next 6 days, so this shows {businessDate}.
        </p>
      )}

      {list.stations.length > 1 && (
        <nav aria-label="Stations" className="mb-4 flex flex-wrap gap-2 print:hidden">
          <Link
            className="rounded-full border px-3 py-1 text-sm"
            aria-current={stationParam === null ? "page" : undefined}
            href={`/kitchen/prep?date=${businessDate}`}
          >
            All stations
          </Link>
          {list.stations.map((station) => (
            <Link
              key={station.id}
              className="rounded-full border px-3 py-1 text-sm"
              aria-current={stationParam === station.id ? "page" : undefined}
              href={`/kitchen/prep?date=${businessDate}&station=${station.id}`}
            >
              {station.name}
            </Link>
          ))}
        </nav>
      )}

      {list.status === "NOT_ENOUGH_HISTORY" && (
        <p role="note" className="mb-4 text-sm text-neutral-700">
          Not enough history for this weekday yet (fewer closed same-weekday dates than the forecast needs), so there are
          no expected portions.
        </p>
      )}
      {list.status === "OK" && (
        <p className="mb-4 text-sm text-neutral-700">From {list.sampleDates.join(", ")}.</p>
      )}

      {shown.length === 0 && <EmptyState title="No stations to show." />}

      <div className="grid gap-4">
        {shown.map((station) => (
          <Card key={station.id} aria-label={`Prep for ${station.name}`}>
            <CardTitle>{station.name}</CardTitle>
            {station.items.length === 0 ? (
              <p className="text-sm text-neutral-700">No items are routed to this station.</p>
            ) : (
              <TableFrame>
                <Table>
                  <THead>
                    <Tr>
                      <Th>Item</Th>
                      <Th>Portions</Th>
                      <Th>Usually asked for</Th>
                      <Th>Ingredients</Th>
                    </Tr>
                  </THead>
                  <TBody>
                    {station.items.map((item) => (
                      <Tr key={item.menuItemId}>
                        <Td>
                          {item.name}
                          {item.newItem && (
                            <>
                              {" "}
                              <Badge tone="warning">New item</Badge>
                            </>
                          )}
                        </Td>
                        <Td>
                          {item.portions === null ? (
                            "—"
                          ) : (
                            <>
                              <span className="font-semibold">{item.portions}</span>
                              {item.sentToday > 0 && (
                                <span className="block text-xs text-neutral-600">{item.sentToday} already sent</span>
                              )}
                            </>
                          )}
                        </Td>
                        <Td>
                          {item.modifiers.length === 0
                            ? "—"
                            : item.modifiers.map((modifier) => `about ${modifier.count} ${modifier.name}`).join(", ")}
                        </Td>
                        <Td>
                          {item.noRecipe ? (
                            <span className="text-neutral-600">No recipe</span>
                          ) : item.ingredients.length === 0 ? (
                            "—"
                          ) : (
                            <ul className="grid gap-0.5">
                              {item.ingredients.map((ingredient) => (
                                <li key={ingredient.inventoryItemId}>
                                  {ingredient.name}: {formatQuantity(ingredient.baseQuantity)} {ingredient.unitCode}
                                </li>
                              ))}
                            </ul>
                          )}
                        </Td>
                      </Tr>
                    ))}
                  </TBody>
                </Table>
              </TableFrame>
            )}
          </Card>
        ))}
      </div>
    </>
  );
}
