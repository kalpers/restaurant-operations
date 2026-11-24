import { Badge, type Tone } from "@/components/ui/badge";
import type { SupplierInvoiceStatus } from "@/db/schema/supplier-invoices";

export const INVOICE_STATUS: Record<SupplierInvoiceStatus, { label: string; tone: Tone }> = {
  DRAFT: { label: "Draft", tone: "neutral" },
  DISPUTED: { label: "Disputed", tone: "warning" },
  APPROVED: { label: "Approved", tone: "success" },
  VOIDED: { label: "Voided", tone: "danger" },
};

/** Phase 36 (policy 8): a supplier invoice's status. */
export function InvoiceStatusBadge({ status }: { status: SupplierInvoiceStatus }) {
  return <Badge tone={INVOICE_STATUS[status].tone}>{INVOICE_STATUS[status].label}</Badge>;
}
