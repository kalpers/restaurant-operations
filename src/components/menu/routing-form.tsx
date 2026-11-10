"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { sendApiRequest } from "@/components/forms/api-request";

type RoutingFormProps = {
  menuItemId: string;
  stations: { id: string; code: string; name: string }[];
  selectedIds: string[];
};

/** Chooses the stations that prepare an item at this location. Configuration only. */
export function RoutingForm({ menuItemId, stations, selectedIds }: RoutingFormProps) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const prepStationIds = data.getAll("prepStationIds").map(String);

    setPending(true);
    setMessage(null);
    const result = await sendApiRequest("PUT", `/api/menu/items/${menuItemId}/routing`, {
      prepStationIds,
    });
    setPending(false);

    if (result.ok) {
      setMessage({ ok: true, text: "Saved." });
      router.refresh();
    } else if (result.status === 401) {
      router.push("/login");
    } else {
      setMessage({ ok: false, text: result.message });
    }
  }

  if (stations.length === 0) {
    return <p className="text-neutral-600">No active prep stations at this location.</p>;
  }

  return (
    <form onSubmit={handleSubmit} className="grid gap-3">
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">Prepared at</legend>
        {stations.map((station) => (
          <label key={station.id} className="flex min-h-11 items-center gap-3">
            <input
              type="checkbox"
              name="prepStationIds"
              value={station.id}
              defaultChecked={selectedIds.includes(station.id)}
              className="size-5"
            />
            {station.name}
          </label>
        ))}
      </fieldset>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="min-h-11 rounded-md bg-brand-700 px-4 py-2 font-medium text-white shadow-sm hover:bg-brand-800 disabled:opacity-50"
        >
          {pending ? "Saving..." : "Save routing"}
        </button>
        {message && (
          <p
            role={message.ok ? "status" : "alert"}
            className={message.ok ? "text-success-800" : "text-danger-700"}
          >
            {message.text}
          </p>
        )}
      </div>
    </form>
  );
}
