// Phase 19 policy 19 (decision D9): sales by the local hour an order was opened, laid out from
// the business-day cutoff hour, so a 4:00 AM cutoff lists 04:00 first and 03:00 last.

export function hoursFromCutoff(businessDayCutoff: string): number[] {
  const start = Number(businessDayCutoff.slice(0, 2));

  return Array.from({ length: 24 }, (_, index) => (start + index) % 24);
}

export function hourLabel(hour: number): string {
  const pad = (value: number) => String(value).padStart(2, "0");

  return `${pad(hour)}:00–${pad(hour)}:59`;
}
