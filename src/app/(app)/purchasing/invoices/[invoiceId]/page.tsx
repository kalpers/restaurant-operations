import { notFound } from "next/navigation";
import { z } from "zod";

import { InvoiceActions } from "@/components/inventory/invoice-actions";
import { InvoiceStatusBadge } from "@/components/inventory/invoice-status-badge";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Table, TableFrame, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { actorHolds, canSeeCost } from "@/modules/inventory/services/access";
import { getInvoice } from "@/modules/inventory/services/invoice-service";
import { NotFoundError } from "@/shared/errors/app-error";

const KIND_LABELS = { ITEM: "Item", FREIGHT: "Freight", TAX: "Tax", OTHER: "Other charge", CREDIT: "Credit" } as const;

/** Phase 36 (policy 8): one invoice, its three-way match per line, and its approval. */
export default async function SupplierInvoicePage({ params }: { params: Promise<{ invoiceId: string }> }) {
  const { actor } = await requirePageActor("purchasing.view");
  const parsed = z.uuid().safeParse((await params).invoiceId);

  if (!parsed.success) {
    notFound();
  }

  const invoice = await getInvoice(getDatabase(), actor, parsed.data).catch((error) => {
    if (error instanceof NotFoundError) {
      notFound();
    }

    throw error;
  });
  const money = canSeeCost(actor);
  const canRecord = actorHolds(actor, "purchasing.invoices.record") && money;
  const canApprove = actorHolds(actor, "purchasing.invoices.approve") && money;
  const editable = invoice.status === "DRAFT" || invoice.status === "DISPUTED";

  return (
    <>
      <PageHeader
        title={`${invoice.invoiceNumber} · ${invoice.supplier.name} ${invoice.supplierInvoiceNumber}`}
        breadcrumbs={[{ label: "Supplier invoices", href: "/purchasing/invoices" }, { label: invoice.invoiceNumber }]}
        actions={
          <>
            {invoice.file && (
              <ButtonLink href={`/api/purchasing/invoices/${invoice.id}/file`} variant="secondary">
                Scanned copy
              </ButtonLink>
            )}
            {canRecord && editable && (
              <ButtonLink href={`/purchasing/invoices/${invoice.id}/edit`} variant="secondary">
                Edit
              </ButtonLink>
            )}
          </>
        }
      />
      <div className="grid gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <InvoiceStatusBadge status={invoice.status} />
          <span className="text-neutral-700">
            Dated {invoice.invoiceDate}
            {invoice.dueDate ? `, due ${invoice.dueDate}` : ""}
          </span>
          {money && (
            <span className="text-neutral-700">
              · Total {invoice.statedTotal}, lines {invoice.linesTotal}
              {invoice.totalsMatch === false && " (they don't match)"}
            </span>
          )}
        </div>
        {invoice.disputeReason && <p className="text-sm">Disputed: {invoice.disputeReason}</p>}
        {invoice.approvalReason && <p className="text-sm">Approved despite variances: {invoice.approvalReason}</p>}
        {invoice.voidReason && <p className="text-sm">Voided: {invoice.voidReason}</p>}
        <InvoiceActions
          invoiceId={invoice.id}
          status={invoice.status}
          version={invoice.version}
          linesNeedingReason={invoice.linesNeedingReason}
          canRecord={canRecord}
          canApprove={canApprove}
        />
        <TableFrame>
          <Table>
            <THead>
              <Tr>
                <Th>Line</Th>
                <Th>Received</Th>
                <Th numeric>Received qty</Th>
                <Th numeric>Invoiced qty</Th>
                {money && <Th numeric>Ordered at</Th>}
                {money && <Th numeric>Receipt cost</Th>}
                {money && <Th numeric>Invoiced price</Th>}
                {money && <Th numeric>Amount</Th>}
                {money && <Th>Match</Th>}
              </Tr>
            </THead>
            <TBody>
              {invoice.lines.map((line) => (
                <Tr key={line.id} data-testid="invoice-line">
                  <Td>{line.kind === "ITEM" ? `${line.receipt?.itemName} (${line.receipt?.unitName})` : `${KIND_LABELS[line.kind]}: ${line.description}`}</Td>
                  <Td>{line.receipt ? `${line.receipt.receivedOn} · ${line.receipt.poNumber}` : ""}</Td>
                  <Td numeric>{line.receipt?.receivedQuantity ?? ""}</Td>
                  <Td numeric>{line.quantity ?? ""}</Td>
                  {money && <Td numeric>{line.receipt?.orderedUnitPrice ?? ""}</Td>}
                  {money && <Td numeric>{line.receipt?.receiptUnitCost ?? ""}</Td>}
                  {money && <Td numeric>{line.unitPrice ?? ""}</Td>}
                  {money && <Td numeric>{line.amount}</Td>}
                  {money && (
                    <Td>
                      {line.variance ? (
                        <span className="flex flex-wrap gap-1">
                          {line.variance.withinTolerance ? (
                            <Badge tone="success">Matches</Badge>
                          ) : (
                            <>
                              {!line.variance.quantityMatches && <Badge tone="warning">Qty {line.variance.quantityVariance}</Badge>}
                              {!line.variance.priceWithinTolerance && (
                                <Badge tone="warning">
                                  Price {line.variance.priceVariance}
                                  {line.variance.pricePercent ? ` (${line.variance.pricePercent}%)` : ""}
                                </Badge>
                              )}
                            </>
                          )}
                        </span>
                      ) : null}
                    </Td>
                  )}
                </Tr>
              ))}
            </TBody>
          </Table>
        </TableFrame>
        {invoice.notes && <p className="whitespace-pre-wrap text-sm">Notes: {invoice.notes}</p>}
      </div>
    </>
  );
}
