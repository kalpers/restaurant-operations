import { InvoiceForm } from "@/components/inventory/invoice-form";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { listSuppliers } from "@/modules/inventory/services/supplier-service";

/** Phase 36 (policy 8): enter a supplier invoice as a draft. */
export default async function NewSupplierInvoicePage() {
  const { actor } = await requirePageActor("purchasing.invoices.record");
  const suppliers = (await listSuppliers(getDatabase(), actor)).filter((supplier) => supplier.active).map(({ id, name }) => ({ id, name }));

  return (
    <>
      <PageHeader
        title="Enter an invoice"
        breadcrumbs={[
          { label: "Supplier invoices", href: "/purchasing/invoices" },
          { label: "Enter an invoice" },
        ]}
      />
      {suppliers.length === 0 ? (
        <EmptyState title="No suppliers">Add a supplier before entering its invoices.</EmptyState>
      ) : (
        <InvoiceForm suppliers={suppliers} />
      )}
    </>
  );
}
