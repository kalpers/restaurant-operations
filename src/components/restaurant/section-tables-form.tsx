"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { sendApiRequest } from "@/components/forms/api-request";

/** Sets exactly which tables a section holds. */
export function SectionTablesForm({
  sectionId,
  version,
  tables,
  initialTableIds,
}: {
  sectionId: string;
  version: number;
  tables: readonly { id: string; tableNumber: string }[];
  initialTableIds: readonly string[];
}) {
  const router = useRouter();
  const [chosen, setChosen] = useState<string[]>([...initialTableIds]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setPending(true);
    setError(null);

    const result = await sendApiRequest(
      "PUT",
      `/api/restaurant/sections/${sectionId}/tables`,
      { tableIds: chosen, expectedVersion: version },
    );

    setPending(false);

    if (result.ok) {
      router.refresh();
    } else if (result.status === 401) {
      router.push("/login");
    } else {
      setError(result.message);
    }
  }

  return (
    <div className="grid gap-2">
      <fieldset>
        <legend className="text-sm font-medium">Tables in this section</legend>
        <div className="flex flex-wrap gap-3">
          {tables.map((table) => (
            <label key={table.id} className="flex min-h-11 items-center gap-2">
              <input
                type="checkbox"
                checked={chosen.includes(table.id)}
                onChange={() =>
                  setChosen((current) =>
                    current.includes(table.id)
                      ? current.filter((id) => id !== table.id)
                      : [...current, table.id],
                  )
                }
                className="size-5"
              />
              {table.tableNumber}
            </label>
          ))}
        </div>
      </fieldset>
      {error && (
        <p role="alert" className="text-sm text-danger-700">
          {error}
        </p>
      )}
      <div>
        <button
          type="button"
          onClick={save}
          disabled={pending}
          className="min-h-11 rounded-md border border-neutral-300 px-3 py-1 text-sm font-medium disabled:opacity-50"
        >
          Save tables
        </button>
      </div>
    </div>
  );
}
