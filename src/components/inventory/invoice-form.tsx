"use client";

import { Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import { ApiErrorMessage } from "@/components/forms/api-error-message";
import { sendApiJson, type ApiFailure } from "@/components/forms/api-request";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, FieldHint, Input, Select, Textarea } from "@/components/ui/field";
import { Table, TableFrame, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import type { InvoiceView, ReceiptLineFacts } from "@/modules/inventory/services/invoice-service";
import { isDecimalString, multiplyExact, roundHalfUp, sumDecimals } from "@/shared/decimal/decimal";

type Failure = Pick<ApiFailure, "code" | "message" | "requestId">;
type ItemDraft = { chosen: boolean; quantity: string; unitPrice: string };
type ChargeDraft = { key: string; kind: "FREIGHT" | "TAX" | "OTHER" | "CREDIT"; description: string; amount: string };

const CHARGE_LABELS: Record<ChargeDraft["kind"], string> = { FREIGHT: "Freight", TAX: "Tax", OTHER: "Other charge", CREDIT: "Credit" };


/** A typed amount as an exact decimal, or null while it isn't one yet (rule 14: never a JS number). */
function decimalOrNull(value: string): string | null {
  return isDecimalString(value.trim()) ? value.trim() : null;
}

/** Sums the typed amounts to the cent, for the running total (the server has the final word). */
function sumCents(values: readonly string[]): string {
  return sumDecimals(
    values.map((value) => decimalOrNull(value) ?? "0").map((value) => roundHalfUp(value, 2)),
    2,
  );
}

function lineCents(quantity: string, unitPrice: string): string {
  const q = decimalOrNull(quantity);
  const p = decimalOrNull(unitPrice);

  return q && p ? roundHalfUp(multiplyExact(q, p), 2) : "0.00";
}

/**
 * Phase 36 (policy 8): enters or corrects a supplier invoice. Item lines are the supplier's
 * received lines (prefilled from the receipt); charge lines are freight, tax, other charges and
 * credits. The lines must add up to the stated total before the invoice can be approved.
 */
export function InvoiceForm({ invoice, suppliers }: { invoice?: InvoiceView; suppliers: { id: string; name: string }[] }) {
  const router = useRouter();
  const toast = useToast();
  const [supplierId, setSupplierId] = useState(invoice?.supplier.id ?? suppliers[0]?.id ?? "");
  const [receiptLines, setReceiptLines] = useState<ReceiptLineFacts[]>([]);
  const [items, setItems] = useState<Record<string, ItemDraft>>({});
  const [charges, setCharges] = useState<ChargeDraft[]>(
    invoice?.lines
      .filter((line) => line.kind !== "ITEM")
      .map((line) => ({
        key: crypto.randomUUID(),
        kind: line.kind as ChargeDraft["kind"],
        description: line.description ?? "",
        amount: (line.amount ?? "0").replace("-", ""),
      })) ?? [],
  );
  const [statedTotal, setStatedTotal] = useState(invoice?.statedTotal ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Failure | null>(null);

  useEffect(() => {
    if (!supplierId) {
      return;
    }

    let current = true;
    const query = new URLSearchParams({ supplierId, ...(invoice ? { invoiceId: invoice.id } : {}) });

    void sendApiJson<{ lines: ReceiptLineFacts[] }>("GET", `/api/purchasing/invoices/receipt-lines?${query.toString()}`).then((result) => {
      if (!current || !result.ok) {
        return;
      }

      setReceiptLines(result.data.lines);
      setItems(
        Object.fromEntries(
          result.data.lines.map((line) => {
            const existing = invoice?.lines.find((entry) => entry.receipt?.receiptLineId === line.receiptLineId);

            return [
              line.receiptLineId,
              existing
                ? { chosen: true, quantity: existing.quantity ?? line.receivedQuantity, unitPrice: existing.unitPrice ?? line.receiptUnitCost }
                : { chosen: false, quantity: line.receivedQuantity, unitPrice: line.receiptUnitCost },
            ];
          }),
        ),
      );
    });

    return () => {
      current = false;
    };
  }, [supplierId, invoice]);

  const runningTotal = useMemo(
    () =>
      sumCents([
        ...Object.values(items)
          .filter((item) => item.chosen)
          .map((item) => lineCents(item.quantity, item.unitPrice)),
        ...charges.map((charge) => (charge.kind === "CREDIT" ? `-${charge.amount}` : charge.amount)),
      ]),
    [items, charges],
  );

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const data = new FormData(event.currentTarget);
    const body = {
      ...(invoice ? { expectedVersion: invoice.version } : { supplierId }),
      supplierInvoiceNumber: data.get("supplierInvoiceNumber"),
      invoiceDate: data.get("invoiceDate"),
      dueDate: data.get("dueDate") || null,
      statedTotal,
      notes: String(data.get("notes") ?? "").trim() || null,
      lines: [
        ...receiptLines
          .filter((line) => items[line.receiptLineId]?.chosen)
          .map((line) => ({
            kind: "ITEM" as const,
            receiptLineId: line.receiptLineId,
            quantity: items[line.receiptLineId]!.quantity,
            unitPrice: items[line.receiptLineId]!.unitPrice,
          })),
        ...charges.map((charge) => ({ kind: charge.kind, description: charge.description, amount: charge.amount })),
      ],
    };

    setPending(true);
    setError(null);

    const result = invoice
      ? await sendApiJson<InvoiceView>("PATCH", `/api/purchasing/invoices/${invoice.id}`, body)
      : await sendApiJson<InvoiceView>("POST", "/api/purchasing/invoices", body);

    setPending(false);

    if (result.ok) {
      toast.success(invoice ? "Invoice saved." : `${result.data.invoiceNumber} entered.`);
      router.push(`/purchasing/invoices/${result.data.id}`);
      router.refresh();
    } else {
      setError(result);
    }
  }

  const setItem = (id: string, change: Partial<ItemDraft>) => setItems((current) => ({ ...current, [id]: { ...current[id]!, ...change } }));

  return (
    <form onSubmit={handleSubmit} className="grid gap-4" aria-label={invoice ? `Edit ${invoice.invoiceNumber}` : "Enter an invoice"}>
      <div className="grid gap-3 sm:grid-cols-5">
        <Field label="Supplier">
          <Select value={supplierId} onChange={(event) => setSupplierId(event.target.value)} disabled={invoice !== undefined}>
            {suppliers.map((supplier) => (
              <option key={supplier.id} value={supplier.id}>
                {supplier.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Supplier's invoice number">
          <Input name="supplierInvoiceNumber" required maxLength={40} defaultValue={invoice?.supplierInvoiceNumber ?? ""} />
        </Field>
        <Field label="Invoice date">
          <Input name="invoiceDate" type="date" required defaultValue={invoice?.invoiceDate ?? ""} />
        </Field>
        <Field label="Due date">
          <Input name="dueDate" type="date" defaultValue={invoice?.dueDate ?? ""} />
        </Field>
        <Field label="Invoice total">
          <Input inputMode="decimal" required value={statedTotal} onChange={(event) => setStatedTotal(event.target.value)} />
        </Field>
      </div>
      <section aria-labelledby="item-lines-heading" className="grid gap-2">
        <h2 id="item-lines-heading" className="font-semibold">
          Received lines
        </h2>
        {receiptLines.length === 0 ? (
          <p className="text-sm text-neutral-700">Nothing received from this supplier is waiting for an invoice.</p>
        ) : (
          <TableFrame>
            <Table>
              <THead>
                <Tr>
                  <Th>On invoice</Th>
                  <Th>Received</Th>
                  <Th>Item</Th>
                  <Th numeric>Received qty</Th>
                  <Th numeric>Receipt cost</Th>
                  <Th>Invoiced qty</Th>
                  <Th>Invoiced unit price</Th>
                </Tr>
              </THead>
              <TBody>
                {receiptLines.map((line) => {
                  const item = items[line.receiptLineId];

                  return (
                    <Tr key={line.receiptLineId} data-testid="invoice-receipt-line">
                      <Td>
                        <Checkbox
                          label={`Invoice ${line.itemName}`}
                          checked={item?.chosen ?? false}
                          onChange={(event) => setItem(line.receiptLineId, { chosen: event.target.checked })}
                        />
                      </Td>
                      <Td>
                        {line.receivedOn} · {line.poNumber}
                      </Td>
                      <Td>
                        {line.itemName} ({line.unitName})
                      </Td>
                      <Td numeric>{line.receivedQuantity}</Td>
                      <Td numeric>{line.receiptUnitCost}</Td>
                      <Td>
                        <Input
                          aria-label={`Invoiced quantity of ${line.itemName}`}
                          inputMode="decimal"
                          value={item?.quantity ?? ""}
                          disabled={!item?.chosen}
                          onChange={(event) => setItem(line.receiptLineId, { quantity: event.target.value })}
                        />
                      </Td>
                      <Td>
                        <Input
                          aria-label={`Invoiced unit price of ${line.itemName}`}
                          inputMode="decimal"
                          value={item?.unitPrice ?? ""}
                          disabled={!item?.chosen}
                          onChange={(event) => setItem(line.receiptLineId, { unitPrice: event.target.value })}
                        />
                      </Td>
                    </Tr>
                  );
                })}
              </TBody>
            </Table>
          </TableFrame>
        )}
      </section>
      <fieldset className="grid gap-2">
        <legend className="font-semibold">Other lines</legend>
        {charges.map((charge, index) => (
          <div key={charge.key} className="flex flex-wrap items-end gap-2">
            <Field label={`Line ${index + 1} kind`}>
              <Select
                value={charge.kind}
                onChange={(event) =>
                  setCharges((current) => current.map((entry) => (entry.key === charge.key ? { ...entry, kind: event.target.value as ChargeDraft["kind"] } : entry)))
                }
              >
                {(Object.keys(CHARGE_LABELS) as ChargeDraft["kind"][]).map((kind) => (
                  <option key={kind} value={kind}>
                    {CHARGE_LABELS[kind]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={`Line ${index + 1} description`}>
              <Input
                value={charge.description}
                maxLength={200}
                onChange={(event) =>
                  setCharges((current) => current.map((entry) => (entry.key === charge.key ? { ...entry, description: event.target.value } : entry)))
                }
              />
            </Field>
            <Field label={`Line ${index + 1} amount`}>
              <Input
                inputMode="decimal"
                value={charge.amount}
                onChange={(event) =>
                  setCharges((current) => current.map((entry) => (entry.key === charge.key ? { ...entry, amount: event.target.value } : entry)))
                }
              />
            </Field>
            <Button variant="ghost" aria-label={`Remove line ${index + 1}`} onClick={() => setCharges((current) => current.filter((entry) => entry.key !== charge.key))}>
              <Trash2 aria-hidden className="size-4" />
            </Button>
          </div>
        ))}
        <div>
          <Button
            variant="secondary"
            onClick={() => setCharges((current) => [...current, { key: crypto.randomUUID(), kind: "FREIGHT", description: "", amount: "" }])}
          >
            <Plus aria-hidden className="size-4" /> Add freight, tax, charge or credit
          </Button>
        </div>
        <FieldHint>Enter a credit as a positive amount; it is taken off.</FieldHint>
      </fieldset>
      <p className="text-sm" data-testid="invoice-running-total">
        Lines come to <strong>{runningTotal}</strong>
        {statedTotal && sumCents([statedTotal]) !== runningTotal ? ` (the invoice says ${sumCents([statedTotal])})` : ""}.
      </p>
      <Field label="Notes">
        <Textarea name="notes" maxLength={2000} rows={2} defaultValue={invoice?.notes ?? ""} />
      </Field>
      <ApiErrorMessage error={error} />
      <div>
        <Button type="submit" variant="primary" pending={pending} pendingLabel="Saving…">
          {invoice ? "Save invoice" : "Enter invoice"}
        </Button>
      </div>
    </form>
  );
}
