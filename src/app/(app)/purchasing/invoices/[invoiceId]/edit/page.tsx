import { notFound } from "next/navigation";
import { z } from "zod";

import { InvoiceForm } from "@/components/inventory/invoice-form";
import { PageHeader } from "@/components/ui/page-header";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { getInvoice } from "@/modules/inventory/services/invoice-service";
import { NotFoundError } from "@/shared/errors/app-error";

/** Phase 36 (policy 8): correct a draft or disputed invoice. */
export default async function EditSupplierInvoicePage({ params }: { params: Promise<{ invoiceId: string }> }) {
  const { actor } = await requirePageActor("purchasing.invoices.record");
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

  return (
    <>
      <PageHeader
        title={`Edit ${invoice.invoiceNumber}`}
        breadcrumbs={[
          { label: "Supplier invoices", href: "/purchasing/invoices" },
          { label: invoice.invoiceNumber, href: `/purchasing/invoices/${invoice.id}` },
          { label: "Edit" },
        ]}
      />
      <InvoiceForm invoice={invoice} suppliers={[invoice.supplier]} />
    </>
  );
}
