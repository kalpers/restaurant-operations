import type { ReportCell, ReportResult, ReportSection } from "../types";

/**
 * Text a spreadsheet would run as a formula starts with one of these, so such text gets an
 * apostrophe prefix and an exported value can never execute (CSV injection). A plain
 * negative number such as "-1.50" is left as a number.
 */
const FORMULA_START = /^[=+\-@\t\r]/;
const NUMERIC = /^-?\d+(\.\d+)?$/;

export function csvCell(value: ReportCell): string {
  if (value === null) {
    return "";
  }

  let text = String(value);

  if (typeof value === "string" && FORMULA_START.test(text) && !NUMERIC.test(text)) {
    text = `'${text}`;
  }

  return /[",\r\n]/.test(text) || text !== text.trim() ? `"${text.replaceAll('"', '""')}"` : text;
}

export function csvLine(values: readonly ReportCell[]): string {
  return values.map(csvCell).join(",");
}

function sectionLines(section: ReportSection): string[] {
  return [
    csvLine(section.columns.map((column) => column.label)),
    ...section.rows.map((row) => csvLine(section.columns.map((column) => row[column.key] ?? null))),
  ];
}

/**
 * RFC 4180 text with CRLF line breaks. A short header names the report, location, business
 * dates and notes. One section is a plain table; several each follow a title line, with a
 * blank line between them.
 */
export function reportToCsv(report: ReportResult, sections: readonly ReportSection[]): string {
  const header = [
    csvLine(["Report", report.title]),
    csvLine(["Location", report.location.name]),
    csvLine(["Business dates", `${report.filters.from} to ${report.filters.to}`]),
    ...report.notes.map((note) => csvLine(["Note", note])),
  ];
  const body =
    sections.length === 1
      ? sectionLines(sections[0]!)
      : sections.flatMap((section, index) => [
          ...(index > 0 ? [""] : []),
          csvLine([section.title]),
          ...sectionLines(section),
        ]);

  return `${[...header, "", ...body].join("\r\n")}\r\n`;
}

/** A safe download name such as `sales_MAIN_2030-01-01_2030-01-07.csv`. */
export function csvFileName(report: ReportResult, section?: string): string {
  const safe = (text: string) => text.replace(/[^A-Za-z0-9_-]/g, "");
  const parts = [report.area, section, report.location.code, report.filters.from, report.filters.to]
    .filter((part): part is string => Boolean(part))
    .map(safe)
    .filter(Boolean);

  return `${parts.join("_")}.csv`;
}
