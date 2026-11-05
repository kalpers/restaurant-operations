"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { sendApiRequest } from "./api-request";

type ActionButtonProps = {
  method: "PATCH" | "PUT" | "DELETE";
  url: string;
  body?: unknown;
  label: string;
};

/** A single-click change to one record, showing any error beside the button. */
export function ActionButton({ method, url, body, label }: ActionButtonProps) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setPending(true);
    setError(null);
    const result = await sendApiRequest(method, url, body);
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
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={handleClick}
        disabled={pending}
        className="min-h-11 rounded border border-neutral-400 px-3 py-1 text-sm font-medium disabled:opacity-50"
      >
        {label}
      </button>
      {error && (
        <span role="alert" className="text-sm text-red-700">
          {error}
        </span>
      )}
    </span>
  );
}
