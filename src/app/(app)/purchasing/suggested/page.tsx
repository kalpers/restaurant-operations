import Link from "next/link";

import { formatCost, formatQuantity } from "@/components/inventory/format";
import { CreateSuggestedOrdersButton } from "@/components/inventory/create-suggested-orders-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Select } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { Table, TableFrame, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { previewSuggestedOrders } from "@/modules/inventory/services/suggested-order-service";
import { readForecastInputs } from "@/modules/scheduling/queries/forecast-inputs";
import { businessDateOf } from "@/shared/time/business-date-service";
import { addDays } from "@/shared/time/zoned-time";
import { MAXIMUM_DAYS_AHEAD } from "@/workflows/forecast-items/forecast-items";
import { previewForecastSuggestedOrders } from "@/workflows/forecast-items/forecast-suggested-orders";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Suggested purchase orders (Phase 19 decisions D7/D8). A preview of what draft orders would
 * hold; creating them makes drafts only, which a person reviews and submits. Phase 25 (D6):
 * "From the forecast" orders what the coming days will use, plus the reorder level, less what
 * is on hand and on order; items the forecast doesn't cover stay on par.
 */
export default async function SuggestedOrdersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { location, actor } = await requirePageActor("purchasing.manage");
  const database = getDatabase();
  const params = await searchParams;
  const { clock } = await readForecastInputs(database, actor.locationId);
  const today = businessDateOf(new Date(), clock);
  const latest = addDays(today, MAXIMUM_DAYS_AHEAD);
  const requested = typeof params.through === "string" && DATE_PATTERN.test(params.through) ? params.through : null;
  const throughDate = requested && requested > today && requested <= latest ? requested : addDays(today, 7);
  const forecastBasis = params.basis === "forecast";
  const suggestion = forecastBasis
    ? await previewForecastSuggestedOrders(database, actor, { throughDate })
    : await previewSuggestedOrders(database, actor);
  const missing = suggestion.forecast?.dates.filter((date) => date.status !== "OK") ?? [];

  return (
    <>
      <PageHeader
        title="Suggested orders"
        description={
          forecastBasis ? (
            <>
              {location.locationName} · what the forecast says today through {throughDate} will use, plus each item&apos;s
              reorder level, less what is on hand and on order, in whole purchase units from the preferred supplier. Items
              the forecast doesn&apos;t cover use their par levels.
            </>
          ) : (
            <>
              {location.locationName} · items at or below their reorder level, topped up to the reorder target (or par),
              less what is already on order, in whole purchase units from each item&apos;s preferred supplier.
            </>
          )
        }
        actions={
          <CreateSuggestedOrdersButton
            supplierCount={suggestion.suppliers.length}
            forecastThrough={forecastBasis ? throughDate : null}
          />
        }
      />

      <form method="get" aria-label="Suggestion basis" className="mb-6 flex flex-wrap items-end gap-3">
        <Field label="Based on">
          <Select name="basis" defaultValue={forecastBasis ? "forecast" : "par"}>
            <option value="par">Par levels</option>
            <option value="forecast">The forecast</option>
          </Select>
        </Field>
        <Field label="Forecast through">
          <Input type="date" name="through" defaultValue={throughDate} min={addDays(today, 1)} max={latest} />
        </Field>
        <Button type="submit" variant="secondary">
          Show
        </Button>
      </form>

      {requested && requested !== throughDate && (
        <p role="status" className="mb-4 text-sm text-warning-900">
          The forecast reaches from tomorrow to {MAXIMUM_DAYS_AHEAD} days ahead, so it shows through {throughDate}.
        </p>
      )}

      {missing.length > 0 && (
        <p role="note" className="mb-4 text-sm text-neutral-700">
          Not enough history yet for {missing.map((date) => date.businessDate).join(", ")}: nothing is forecast for those
          dates.
        </p>
      )}

      {suggestion.suppliers.length === 0 && suggestion.withoutSupplier.length === 0 && (
        <EmptyState title="Nothing needs ordering right now." />
      )}

      <div className="grid gap-4">
        {suggestion.suppliers.map((group) => (
          <Card key={group.supplierId} aria-label={`Suggested from ${group.supplierName}`}>
            <CardTitle>{group.supplierName}</CardTitle>
            <TableFrame>
              <Table>
                <THead>
                  <Tr>
                    <Th>Item</Th>
                    {forecastBasis && <Th>Basis</Th>}
                    {forecastBasis && <Th>Forecast use</Th>}
                    {forecastBasis && <Th>Reorder level</Th>}
                    <Th>On hand</Th>
                    <Th>On order</Th>
                    <Th>Need</Th>
                    <Th>Order</Th>
                    <Th>Estimate</Th>
                  </Tr>
                </THead>
                <TBody>
                  {group.lines.map((line) => (
                    <Tr key={line.inventoryItemId}>
                      <Td>{line.name}</Td>
                      {forecastBasis && (
                        <Td>
                          <Badge tone={line.basis === "FORECAST" ? "info" : "neutral"}>
                            {line.basis === "FORECAST" ? "Forecast" : "Par"}
                          </Badge>
                        </Td>
                      )}
                      {forecastBasis && (
                        <Td>
                          {line.forecastUsageBaseQuantity
                            ? `${formatQuantity(line.forecastUsageBaseQuantity)} ${line.baseUnitCode}`
                            : "—"}
                        </Td>
                      )}
                      {forecastBasis && (
                        <Td>{line.reorderFloor ? `${formatQuantity(line.reorderFloor)} ${line.baseUnitCode}` : "—"}</Td>
                      )}
                      <Td>{formatQuantity(line.quantityOnHand)} {line.baseUnitCode}</Td>
                      <Td>{formatQuantity(line.onOrderBaseQuantity)} {line.baseUnitCode}</Td>
                      <Td>{formatQuantity(line.needBaseQuantity)} {line.baseUnitCode}</Td>
                      <Td>
                        {line.orderedQuantity} {line.purchaseUnitCode}
                      </Td>
                      <Td>{line.estimatedLineCost === null ? "—" : formatCost(line.estimatedLineCost)}</Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            </TableFrame>
          </Card>
        ))}

        {suggestion.withoutSupplier.length > 0 && (
          <Card aria-label="No preferred supplier">
            <CardTitle>Choose a supplier</CardTitle>
            <p className="mb-2 text-sm text-neutral-700">
              These items need ordering but have no preferred supplier here, so they are left off. Set one on the
              item&apos;s stock settings.
            </p>
            <ul className="grid gap-1 text-sm">
              {suggestion.withoutSupplier.map((entry) => (
                <li key={entry.inventoryItemId}>
                  <Link className="underline" href={`/inventory/items/${entry.inventoryItemId}`}>
                    {entry.name}
                  </Link>
                  : need {formatQuantity(entry.needBaseQuantity)} {entry.baseUnitCode}
                  {entry.basis === "FORECAST" && " (forecast)"}
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </>
  );
}
