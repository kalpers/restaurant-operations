"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { callOrderApi } from "./order-api";

/** Opens a dine-in or bar order on a seated party, or a takeout order, then goes to it. */
export function NewOrderButton(
  props:
    | { orderType: "DINE_IN" | "BAR"; tableSessionId: string; label: string }
    | { orderType: "TAKEOUT"; label: string },
) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [customerName, setCustomerName] = useState("");

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const body =
      props.orderType === "TAKEOUT"
        ? { orderType: "TAKEOUT", customerName: customerName.trim() || null }
        : { orderType: props.orderType, tableSessionId: props.tableSessionId };
    const result = await callOrderApi<{ id: string }>("POST", "/api/orders", body);

    setPending(false);

    if (result.ok) {
      router.push(`/orders/${result.data.id}`);
    } else if (result.status === 401) {
      router.push("/login");
    } else {
      setError(result.message);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-2">
      {props.orderType === "TAKEOUT" && (
        <label className="grid gap-1 text-sm font-medium">
          Pickup name (optional)
          <input
            value={customerName}
            maxLength={60}
            onChange={(event) => setCustomerName(event.target.value)}
            className="min-h-11 rounded-md border border-neutral-300 px-3"
          />
        </label>
      )}
      <button
        type="submit"
        disabled={pending}
        className="min-h-11 rounded-md bg-brand-700 px-4 font-medium text-white shadow-sm hover:bg-brand-800 disabled:opacity-50"
      >
        {props.label}
      </button>
      {error && (
        <p role="alert" className="w-full text-sm text-danger-700">
          {error}
        </p>
      )}
    </form>
  );
}
