"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";

import { cn } from "@/components/ui/cn";

import { diffAuditFields, displayValue } from "./audit-format";

/**
 * Before and after side by side, changed fields highlighted, then any extra details.
 * A native disclosure, so it opens even before the page has hydrated.
 */
export function AuditChanges({ before, after, details }: { before: unknown; after: unknown; details: unknown }) {
  const rows = diffAuditFields(before, after);
  const detailRows = diffAuditFields(null, details);

  return (
    <details>
      <summary className="min-h-11 cursor-pointer rounded-md px-2 py-2 font-medium text-brand-800">Show</summary>
      <div className="mt-2 grid gap-3">
          {rows.length > 0 && (
            <table className="w-full min-w-72 border-collapse text-xs">
              <caption className="sr-only">Changes</caption>
              <thead>
                <tr className="bg-neutral-100 text-left">
                  <th scope="col" className="px-2 py-1">Field</th>
                  <th scope="col" className="px-2 py-1">Before</th>
                  <th scope="col" className="px-2 py-1">After</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.field} className={cn("border-b border-neutral-200", row.changed && "bg-warning-50")}>
                    <th scope="row" className="px-2 py-1 text-left font-medium">
                      {row.field}
                      {row.changed && <span className="sr-only"> (changed)</span>}
                    </th>
                    <td className="px-2 py-1 break-all">{row.before ?? "—"}</td>
                    <td className={cn("px-2 py-1 break-all", row.changed && "font-semibold")}>{row.after ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {detailRows.length > 0 && (
            <dl className="grid gap-1 text-xs">
              {detailRows.map((row) => (
                <div key={row.field} className="flex flex-wrap gap-2">
                  <dt className="font-medium">{row.field}:</dt>
                  <dd className="break-all">{row.after}</dd>
                </div>
              ))}
            </dl>
          )}
          {rows.length === 0 && detailRows.length === 0 && <p className="text-xs">{displayValue(null)}</p>}
      </div>
    </details>
  );
}

/** A shortened ID that copies the full one. */
export function CopyId({ id, label }: { id: string; label: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked: the full ID is still in the tooltip.
    }
  }

  const Icon = copied ? Check : Copy;

  return (
    <button
      type="button"
      onClick={copy}
      title={id}
      aria-label={`Copy ID ${label}`}
      className="inline-flex min-h-8 items-center gap-1 rounded px-1 font-mono text-xs text-neutral-700 hover:bg-neutral-100"
    >
      {label}
      <Icon aria-hidden className="size-3" />
    </button>
  );
}
