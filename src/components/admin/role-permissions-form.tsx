"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { sendApiRequest } from "@/components/forms/api-request";

type RolePermissionsFormProps = {
  roleId: string;
  version: number;
  granted: string[];
  catalog: { code: string; name: string; category: string }[];
};

export function RolePermissionsForm({
  roleId,
  version,
  granted,
  catalog,
}: RolePermissionsFormProps) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const categories = [...new Set(catalog.map((item) => item.category))];

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const permissions = new FormData(event.currentTarget).getAll("permission");

    setPending(true);
    setError(null);
    const result = await sendApiRequest(
      "PUT",
      `/api/admin/roles/${roleId}/permissions`,
      { permissions, expectedVersion: version },
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
    <form onSubmit={handleSubmit} className="grid gap-4">
      {categories.map((category) => (
        <fieldset key={category}>
          <legend className="font-medium">{category}</legend>
          <div className="grid gap-1 sm:grid-cols-2">
            {catalog
              .filter((item) => item.category === category)
              .map((item) => (
                <label key={item.code} className="flex min-h-9 items-center gap-2">
                  <input
                    type="checkbox"
                    name="permission"
                    value={item.code}
                    defaultChecked={granted.includes(item.code)}
                    className="size-5"
                  />
                  <span>{item.name}</span>
                </label>
              ))}
          </div>
        </fieldset>
      ))}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="min-h-11 rounded bg-neutral-900 px-4 py-2 font-medium text-white disabled:opacity-50"
        >
          {pending ? "Saving..." : "Save permissions"}
        </button>
        {error && (
          <p role="alert" className="text-red-700">
            {error}
          </p>
        )}
      </div>
    </form>
  );
}
