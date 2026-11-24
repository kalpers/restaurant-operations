import { and, eq, inArray, sql } from "drizzle-orm";

import { locations, supplierInvoices } from "@/db/schema";
import type { DatabaseExecutor, DatabaseTransaction } from "@/db/transactions/transaction-context";
import { redactRowText } from "@/modules/auditing";
import type { Actor } from "@/modules/auth/types";
import { freeTextCondition, hasQuery, joinTexts, type FreeTextCandidate, type FreeTextQuery, type RedactText } from "@/shared/text/free-text-search";

// Phase 36 (policy 3): supplier invoice notes for a guest erase, where the eraser holds
// `purchasing.view`. Only the guest's words become "[redacted]"; a finished invoice's guard
// accepts that only with its `free_text_redactions` record.

export async function findInvoiceNoteCandidates(
  executor: DatabaseExecutor,
  scope: { organizationId: string; locationIds: readonly string[] },
  query: FreeTextQuery,
): Promise<FreeTextCandidate[]> {
  if (scope.locationIds.length === 0 || !hasQuery(query)) {
    return [];
  }

  const rows = await executor
    .select({
      id: supplierInvoices.id,
      locationId: supplierInvoices.locationId,
      locationName: locations.name,
      date: supplierInvoices.invoiceDate,
      invoiceNumber: supplierInvoices.invoiceNumber,
      notes: supplierInvoices.notes,
      disputeReason: supplierInvoices.disputeReason,
      approvalReason: supplierInvoices.approvalReason,
      voidReason: supplierInvoices.voidReason,
    })
    .from(supplierInvoices)
    .innerJoin(locations, eq(locations.id, supplierInvoices.locationId))
    .where(
      and(
        eq(supplierInvoices.organizationId, scope.organizationId),
        inArray(supplierInvoices.locationId, [...scope.locationIds]),
        freeTextCondition(
          [
            sql`${supplierInvoices.notes}`,
            sql`${supplierInvoices.disputeReason}`,
            sql`${supplierInvoices.approvalReason}`,
            sql`${supplierInvoices.voidReason}`,
          ],
          query,
        ),
      ),
    );

  return rows.map((row) => ({
    id: row.id,
    locationId: row.locationId,
    locationName: row.locationName,
    date: row.date,
    label: `Supplier invoice ${row.invoiceNumber}`,
    text: joinTexts(row.notes, row.disputeReason, row.approvalReason, row.voidReason),
  }));
}

export async function redactInvoiceNote(
  transaction: DatabaseTransaction,
  actor: Actor,
  invoiceId: string,
  redact: RedactText,
  reason: string,
): Promise<void> {
  const [row] = await transaction.select().from(supplierInvoices).where(eq(supplierInvoices.id, invoiceId)).for("update");

  if (!row) {
    return;
  }

  const changed = await redactRowText(
    transaction,
    actor,
    { tableName: "supplier_invoices", rowId: row.id, reason },
    {
      notes: { columnName: "notes", value: row.notes },
      disputeReason: { columnName: "dispute_reason", value: row.disputeReason },
      approvalReason: { columnName: "approval_reason", value: row.approvalReason },
      voidReason: { columnName: "void_reason", value: row.voidReason },
    },
    redact,
  );

  if (Object.keys(changed).length > 0) {
    await transaction
      .update(supplierInvoices)
      .set({ ...changed, version: sql`${supplierInvoices.version} + 1` })
      .where(eq(supplierInvoices.id, row.id));
  }
}
