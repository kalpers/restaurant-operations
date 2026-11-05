/** "FULL_TIME" becomes "Full time". */
export function humanize(value: string): string {
  const words = value.replaceAll("_", " ").toLowerCase();

  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function optionsFrom(values: readonly string[]) {
  return values.map((value) => ({ value, label: humanize(value) }));
}

export function dateRange(from: string, to: string | null): string {
  return to ? `${from} to ${to}` : `From ${from}`;
}
