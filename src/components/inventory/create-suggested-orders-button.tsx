"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { ApiErrorMessage } from "@/components/forms/api-error-message";
import { readFailure, type ApiFailure } from "@/components/forms/api-request";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { apiFetch } from "@/components/forms/page-location";

type Created = { purchaseOrders: { id: string; poNumber: string }[] };

function newKey(): string {
  return `suggest-${crypto.randomUUID()}`;
}

/**
 * Creates the suggested DRAFT orders (Phase 19 policy 17). The idempotency key is kept until
 * the request succeeds, so a retry after a lost response returns the same drafts.
 */
export function CreateSuggestedOrdersButton({ supplierCount }: { supplierCount: number }) {
  const router = useRouter();
  const toast = useToast();
  const [key, setKey] = useState(newKey);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiFailure | null>(null);
  const [created, setCreated] = useState<Created["purchaseOrders"]>([]);

  async function create() {
    setPending(true);
    setError(null);

    try {
      const response = await apiFetch("/api/purchasing/suggested-orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idempotencyKey: key }),
      });

      if (response.status === 401) {
        router.push("/login");
        return;
      }

      if (!response.ok) {
        setError(await readFailure(response));
        return;
      }

      const body = (await response.json()) as Created;

      setCreated(body.purchaseOrders);
      setKey(newKey());
      toast.success(
        body.purchaseOrders.length === 0 ? "Nothing new to order." : `Created ${body.purchaseOrders.length} draft order(s).`,
      );
      router.refresh();
    } catch {
      setError({ ok: false, status: 0, code: "NETWORK", message: "Couldn't reach the server. Try again." });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={create} pending={pending} disabled={supplierCount === 0}>
          Create draft orders
        </Button>
        <ApiErrorMessage error={error} />
      </div>
      {created.length > 0 && (
        <ul aria-label="Created drafts" className="text-sm">
          {created.map((order) => (
            <li key={order.id}>
              <a className="underline" href={`/purchasing/orders/${order.id}`}>
                {order.poNumber}
              </a>{" "}
              (draft: review and submit it from the purchase order)
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
