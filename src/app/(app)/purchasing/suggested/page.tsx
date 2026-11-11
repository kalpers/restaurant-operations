import Link from "next/link";

import { formatCost, formatQuantity } from "@/components/inventory/format";
import { CreateSuggestedOrdersButton } from "@/components/inventory/create-suggested-orders-button";
import { Card, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Table, TableFrame, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { previewSuggestedOrders } from "@/modules/inventory/services/suggested-order-service";

/**
 * Suggested purchase orders (Phase 19 decisions D7/D8). A preview of what draft orders would
 * hold; creating them makes drafts only, which a person reviews and submits.
 */
export default async function SuggestedOrdersPage() {
  const { location, actor } = await requirePageActor("purchasing.manage");
  const suggestion = await previewSuggestedOrders(getDatabase(), actor);

  return (
    <>
      <PageHeader
        title="Suggested orders"
        description={
          <>
            {location.locationName} · items at or below their reorder level, topped up to the reorder target (or par),
            less what is already on order, in whole purchase units from each item&apos;s preferred supplier.
          </>
        }
        actions={<CreateSuggestedOrdersButton supplierCount={suggestion.suppliers.length} />}
      />

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
              These items are low but have no preferred supplier here, so they are left off. Set one on the item&apos;s
              stock settings.
            </p>
            <ul className="grid gap-1 text-sm">
              {suggestion.withoutSupplier.map((entry) => (
                <li key={entry.inventoryItemId}>
                  <Link className="underline" href={`/inventory/items/${entry.inventoryItemId}`}>
                    {entry.name}
                  </Link>
                  : need {formatQuantity(entry.needBaseQuantity)} {entry.baseUnitCode}
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </>
  );
}
