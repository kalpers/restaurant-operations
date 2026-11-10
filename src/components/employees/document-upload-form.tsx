"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { sendFormData } from "@/components/forms/api-request";

import { humanize } from "./format";
import { INPUT_STYLE } from "@/components/ui/field";

type DocumentUploadFormProps = {
  url: string;
  documentTypes: readonly string[];
  /** Whether this user may upload sensitive documents. The server checks this too. */
  allowSensitive: boolean;
};

const INPUT_CLASS = INPUT_STYLE;

/** Files go to the server only: there is no public URL for an uploaded document. */
export function DocumentUploadForm({
  url,
  documentTypes,
  allowSensitive,
}: DocumentUploadFormProps) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null,
  );

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);

    // An unchecked box sends nothing, and the server treats silence as sensitive.
    data.set("sensitive", data.get("sensitive") === "on" ? "true" : "false");

    setPending(true);
    setMessage(null);
    const result = await sendFormData(url, data);
    setPending(false);

    if (result.ok) {
      setMessage({ ok: true, text: "Uploaded." });
      form.reset();
      router.refresh();
    } else if (result.status === 401) {
      router.push("/login");
    } else {
      setMessage({ ok: false, text: result.message });
    }
  }

  return (
    <form onSubmit={handleSubmit} className="grid gap-4 sm:grid-cols-2">
      <label className="grid gap-1 text-sm font-medium">
        File
        <input
          type="file"
          name="file"
          required
          accept=".pdf,.png,.jpg,.jpeg,.txt"
          className={INPUT_CLASS}
        />
      </label>
      <label className="grid gap-1 text-sm font-medium">
        Document type
        <select name="documentType" required className={INPUT_CLASS}>
          {documentTypes.map((type) => (
            <option key={type} value={type}>
              {humanize(type)}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-sm font-medium">
        Document name
        <input type="text" name="name" maxLength={200} className={INPUT_CLASS} />
      </label>
      <label className="grid gap-1 text-sm font-medium">
        Description
        <input
          type="text"
          name="description"
          maxLength={500}
          className={INPUT_CLASS}
        />
      </label>
      {allowSensitive && (
        <label className="flex min-h-11 items-center gap-3">
          <input
            type="checkbox"
            name="sensitive"
            defaultChecked
            className="size-5"
          />
          Sensitive document
        </label>
      )}
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <button
          type="submit"
          disabled={pending}
          className="min-h-11 rounded-md bg-brand-700 px-4 py-2 font-medium text-white shadow-sm hover:bg-brand-800 disabled:opacity-50"
        >
          {pending ? "Uploading..." : "Upload document"}
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
