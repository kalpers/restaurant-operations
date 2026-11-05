"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { sendApiRequest } from "./api-request";

export type FormField = {
  name: string;
  label: string;
  type?: "text" | "email" | "password" | "number" | "time" | "checkbox" | "select";
  defaultValue?: string | number | boolean | null;
  required?: boolean;
  minLength?: number;
  autoComplete?: string;
  options?: { value: string; label: string }[];
};

type EntityFormProps = {
  method: "POST" | "PATCH" | "PUT";
  url: string;
  fields: FormField[];
  /** Sent with the form and not displayed, such as the expected version. */
  hidden?: Record<string, unknown>;
  submitLabel: string;
  /** Clears the inputs after success, for forms that create records. */
  resetOnSuccess?: boolean;
};

const INPUT_CLASS =
  "min-h-11 w-full rounded border border-neutral-300 bg-white px-3 py-2 text-base";

function readField(field: FormField, data: FormData): unknown {
  const raw = data.get(field.name);

  if (field.type === "checkbox") {
    return raw === "on";
  }

  const value = typeof raw === "string" ? raw.trim() : "";

  if (field.type === "number") {
    return value === "" ? null : Number(value);
  }

  // Passwords are sent exactly as typed. Blank optional text is stored as null.
  if (field.type === "password") {
    return raw;
  }

  return value === "" && !field.required ? null : value;
}

export function EntityForm({
  method,
  url,
  fields,
  hidden,
  submitLabel,
  resetOnSuccess,
}: EntityFormProps) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null,
  );

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const body = Object.fromEntries(
      fields.map((field) => [field.name, readField(field, data)]),
    );

    setPending(true);
    setMessage(null);
    const result = await sendApiRequest(method, url, { ...body, ...hidden });
    setPending(false);

    if (result.ok) {
      setMessage({ ok: true, text: "Saved." });
      if (resetOnSuccess) {
        form.reset();
      }
      router.refresh();
    } else if (result.status === 401) {
      router.push("/login");
    } else {
      setMessage({ ok: false, text: result.message });
    }
  }

  return (
    <form onSubmit={handleSubmit} className="grid gap-4 sm:grid-cols-2">
      {fields.map((field) =>
        field.type === "checkbox" ? (
          <label key={field.name} className="flex min-h-11 items-center gap-3">
            <input
              type="checkbox"
              name={field.name}
              defaultChecked={field.defaultValue === true}
              className="size-5"
            />
            {field.label}
          </label>
        ) : (
          <label key={field.name} className="grid gap-1 text-sm font-medium">
            {field.label}
            {field.type === "select" ? (
              <select
                name={field.name}
                required={field.required}
                defaultValue={String(field.defaultValue ?? "")}
                className={INPUT_CLASS}
              >
                {field.options?.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type={field.type ?? "text"}
                name={field.name}
                required={field.required}
                minLength={field.minLength}
                autoComplete={field.autoComplete}
                defaultValue={
                  field.defaultValue === null || field.defaultValue === undefined
                    ? undefined
                    : String(field.defaultValue)
                }
                className={INPUT_CLASS}
              />
            )}
          </label>
        ),
      )}
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <button
          type="submit"
          disabled={pending}
          className="min-h-11 rounded bg-neutral-900 px-4 py-2 font-medium text-white disabled:opacity-50"
        >
          {pending ? "Saving..." : submitLabel}
        </button>
        {message && (
          <p
            role={message.ok ? "status" : "alert"}
            className={message.ok ? "text-green-800" : "text-red-700"}
          >
            {message.text}
          </p>
        )}
      </div>
    </form>
  );
}
