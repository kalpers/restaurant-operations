"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { sendApiRequest } from "@/components/forms/api-request";

type ReceivableLine = {
  id: string;
  itemName: string;
  unitCode: string;
  remainingQuantity: string;
  unitPrice: string;
};

const INPUT_CLASS =
  "min-h-11 w-full rounded border border-neutral-300 bg-white px-3 py-2 text-base";

/**
 * Receives one shipment against an order. Blank lines aren't received. The cost defaults to
 * the ordered price; the server refuses anything over the remaining quantity.
 */
export function ReceiveForm({ orderId, lines }: { orderId: string; lines: ReceivableLine[] }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const received = lines.flatMap((line) => {
      const quantity = String(data.get(`quantity-${line.id}`) ?? "").trim();
      const cost = String(data.get(`cost-${line.id}`) ?? "").trim();

      return quantity === ""
        ? []
        : [{ purchaseOrderLineId: line.id, receivedQuantity: quantity, actualUnitCost: cost === "" ? null : cost }];
    });

    if (received.length === 0) {
      setMessage({ ok: false, text: "Enter at least one received quantity." });
      return;
    }

    setPending(true);
    setMessage(null);
    const result = await sendApiRequest("POST", `/api/purchasing/orders/${orderId}/receipts`, {
      lines: received,
      supplierReference: String(data.get("supplierReference") ?? "").trim() || null,
      notes: null,
    });
    setPending(false);

    if (result.ok) {
      setMessage({ ok: true, text: "Received." });
      form.reset();
      router.refresh();
    } else if (result.status === 401) {
      router.push("/login");
    } else {
      setMessage({ ok: false, text: result.message });
    }
  }

  return (
    <form onSubmit={handleSubmit} aria-label="Receive shipment" className="grid gap-4">
      {lines.map((line) => (
        <fieldset key={line.id} className="grid gap-3 rounded border border-neutral-200 p-3 sm:grid-cols-2">
          <legend className="px-1 text-sm font-medium">
            {line.itemName}: {line.remainingQuantity} {line.unitCode} still on order
          </legend>
          <label className="grid gap-1 text-sm font-medium">
            Received {line.itemName} ({line.unitCode})
            <input name={`quantity-${line.id}`} inputMode="decimal" className={INPUT_CLASS} />
          </label>
          <label className="grid gap-1 text-sm font-medium">
            Actual cost per {line.unitCode} for {line.itemName} (ordered at {line.unitPrice})
            <input name={`cost-${line.id}`} inputMode="decimal" className={INPUT_CLASS} />
          </label>
        </fieldset>
      ))}
      <label className="grid gap-1 text-sm font-medium">
        Supplier reference (invoice or delivery number)
        <input name="supplierReference" className={INPUT_CLASS} />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="min-h-11 rounded bg-neutral-900 px-4 py-2 font-medium text-white disabled:opacity-50"
        >
          {pending ? "Receiving..." : "Receive shipment"}
        </button>
        {message && (
          <p role={message.ok ? "status" : "alert"} className={message.ok ? "text-green-800" : "text-red-700"}>
            {message.text}
          </p>
        )}
      </div>
    </form>
  );
}
