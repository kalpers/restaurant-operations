import Link from "next/link";

import { INVOICE_STATUS, InvoiceStatusBadge } from "@/components/inventory/invoice-status-badge";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Select } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { Table, TableFrame, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { getDatabase } from "@/db";
import { SUPPLIER_INVOICE_STATUSES } from "@/db/schema/supplier-invoices";
import { requirePageActor } from "@/modules/auth/guards";
import { actorHolds } from "@/modules/inventory/services/access";
import { listInvoices } from "@/modules/inventory/services/invoice-service";
import { invoiceListQuerySchema } from "@/modules/inventory/validators/invoice-validators";
import { readLocationClock } from "@/modules/restaurant/services/access";
import { addDays } from "@/shared/time/zoned-time";

type SearchParams = Record<string, string | string[] | undefined>;

/** Phase 36 (policy 8): supplier invoices, matched against what was received. */
export default async function SupplierInvoicesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { actor } = await requirePageActor("purchasing.view");
  const database = getDatabase();
  const clock = await readLocationClock(database, actor.locationId, new Date());
  const raw = await searchParams;
  const pick = (name: string) => (typeof raw[name] === "string" && raw[name] !== "" ? (raw[name] as string) : undefined);
  const parsed = invoiceListQuerySchema.safeParse({
    from: pick("from") ?? addDays(clock.localDate, -30),
    to: pick("to") ?? clock.localDate,
    status: pick("status"),
  });
  const invoices = parsed.success ? await listInvoices(database, actor, parsed.data) : [];

  return (
    <>
      <PageHeader
        title="Supplier invoices"
        description="Each invoice is checked line by line against what was received and ordered. Approving one records the variances; it never changes inventory cost."
        breadcrumbs={[{ label: "Purchase orders", href: "/purchasing/orders" }, { label: "Supplier invoices" }]}
        actions={
          actorHolds(actor, "purchasing.invoices.record") && actorHolds(actor, "inventory.cost.view") ? (
            <ButtonLink href="/purchasing/invoices/new" variant="primary">
              Enter an invoice
            </ButtonLink>
          ) : undefined
        }
      />
      <form method="get" aria-label="Choose dates" className="mb-6 flex flex-wrap items-end gap-3">
        <Field label="Invoice date from">
          <Input type="date" name="from" defaultValue={parsed.success ? parsed.data.from : ""} />
        </Field>
        <Field label="To">
          <Input type="date" name="to" defaultValue={parsed.success ? parsed.data.to : ""} />
        </Field>
        <Field label="Status">
          <Select name="status" defaultValue={parsed.success ? (parsed.data.status ?? "") : ""}>
            <option value="">All</option>
            {SUPPLIER_INVOICE_STATUSES.map((status) => (
              <option key={status} value={status}>
                {INVOICE_STATUS[status].label}
              </option>
            ))}
          </Select>
        </Field>
        <Button type="submit" variant="secondary">
          Show
        </Button>
      </form>
      {!parsed.success && (
        <p role="alert" className="mb-4 rounded border border-danger-300 bg-danger-50 p-3 text-danger-800">
          Choose valid dates.
        </p>
      )}
      {invoices.length === 0 ? (
        <EmptyState title="No invoices">No supplier invoices for these dates.</EmptyState>
      ) : (
        <TableFrame>
          <Table>
            <THead>
              <Tr>
                <Th>Invoice</Th>
                <Th>Supplier</Th>
                <Th>Supplier number</Th>
                <Th>Date</Th>
                <Th numeric>Total</Th>
                <Th>Status</Th>
              </Tr>
            </THead>
            <TBody>
              {invoices.map((invoice) => (
                <Tr key={invoice.id} data-testid="invoice-row">
                  <Td>
                    <Link href={`/purchasing/invoices/${invoice.id}`} className="font-medium underline">
                      {invoice.invoiceNumber}
                    </Link>
                  </Td>
                  <Td>{invoice.supplier.name}</Td>
                  <Td>{invoice.supplierInvoiceNumber}</Td>
                  <Td>{invoice.invoiceDate}</Td>
                  <Td numeric>{invoice.statedTotal ?? "—"}</Td>
                  <Td>
                    <span className="flex flex-wrap gap-1">
                      <InvoiceStatusBadge status={invoice.status} />
                      {invoice.linesNeedingReason > 0 && invoice.status !== "VOIDED" && <Badge tone="warning">Variances</Badge>}
                    </span>
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        </TableFrame>
      )}
    </>
  );
}
