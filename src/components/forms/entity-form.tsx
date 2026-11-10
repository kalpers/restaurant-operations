"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { INPUT_STYLE } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";

import { ApiErrorMessage } from "./api-error-message";
import { sendApiRequest, type ApiFailure } from "./api-request";

export type FormField = {
  name: string;
  label: string;
  type?:
    | "text"
    | "email"
    | "password"
    | "number"
    | "time"
    | "date"
    | "datetime-local"
    | "checkbox"
    | "select"
    | "textarea";
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
  /** Toast text after success. */
  successMessage?: string;
};

const INPUT_CLASS = INPUT_STYLE;

function readField(field: FormField, data: FormData): unknown {
  const raw = data.get(field.name);

  if (field.type === "checkbox") {
    return raw === "on";
  }

  const value = typeof raw === "string" ? raw.trim() : "";

  if (field.type === "number") {
    return value === "" ? null : Number(value);
  }

  // The browser gives local wall-clock time; the API takes an exact instant.
  if (field.type === "datetime-local") {
    return value === "" ? null : new Date(value).toISOString();
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
  successMessage = "Saved.",
}: EntityFormProps) {
  const router = useRouter();
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiFailure | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const body = Object.fromEntries(
      fields.map((field) => [field.name, readField(field, data)]),
    );

    setPending(true);
    setError(null);
    const result = await sendApiRequest(method, url, { ...body, ...hidden });
    setPending(false);

    if (result.ok) {
      toast.success(successMessage);
      if (resetOnSuccess) {
        form.reset();
      }
      router.refresh();
    } else if (result.status === 401) {
      router.push("/login");
    } else {
      setError(result);
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
              className="size-5 accent-brand-700"
            />
            {field.label}
          </label>
        ) : (
          <label key={field.name} className="grid gap-1 text-sm font-medium text-neutral-800">
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
            ) : field.type === "textarea" ? (
              <textarea
                name={field.name}
                required={field.required}
                rows={4}
                defaultValue={
                  field.defaultValue === null || field.defaultValue === undefined
                    ? undefined
                    : String(field.defaultValue)
                }
                className={INPUT_CLASS}
              />
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
        <Button type="submit" variant="primary" pending={pending} pendingLabel="Saving...">
          {submitLabel}
        </Button>
        <ApiErrorMessage error={error} />
      </div>
    </form>
  );
}
