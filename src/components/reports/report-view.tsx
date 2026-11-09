import type { ReportResult } from "@/modules/reporting/types";

import { formatCell, isNumericKind } from "./format";

/** Renders a report's sections as read-only tables. */
export function ReportView({
  report,
  exportHref,
}: {
  report: ReportResult;
  /** Builds the CSV link for a section, or the whole report; null when export isn't allowed. */
  exportHref: ((section?: string) => string) | null;
}) {
  return (
    <div className="grid gap-8">
      {report.notes.length > 0 && (
        <ul className="grid gap-1 rounded border border-neutral-200 bg-neutral-50 p-3 text-sm text-neutral-700">
          {report.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}

      {report.sections.map((section) => (
        <section key={section.key} aria-labelledby={`section-${section.key}`}>
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <h2 id={`section-${section.key}`} className="text-lg font-semibold">
              {section.title}
            </h2>
            {exportHref && (
              <a
                href={exportHref(section.key)}
                className="inline-flex min-h-11 items-center text-sm font-medium underline"
                aria-label={`Export ${section.title} as CSV`}
              >
                Export CSV
              </a>
            )}
          </div>
          {section.description && <p className="mb-2 text-sm text-neutral-600">{section.description}</p>}

          {section.rows.length === 0 ? (
            <p className="text-neutral-600">Nothing in this range.</p>
          ) : (
            <div className="overflow-x-auto">
              <table aria-label={section.title} className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-neutral-300">
                    {section.columns.map((column) => (
                      <th
                        key={column.key}
                        scope="col"
                        className={`py-2 pr-3 font-semibold ${isNumericKind(column.kind) ? "text-right" : ""}`}
                      >
                        {column.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {section.rows.map((row, index) => (
                    <tr key={index} className="border-b border-neutral-100">
                      {section.columns.map((column) => (
                        <td
                          key={column.key}
                          className={`py-2 pr-3 ${isNumericKind(column.kind) ? "text-right tabular-nums" : ""}`}
                        >
                          {formatCell(column.kind, row[column.key] ?? null)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
