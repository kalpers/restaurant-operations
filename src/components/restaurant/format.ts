import type { TableAvailability } from "@/modules/restaurant/types";

export const AVAILABILITY_LABELS: Record<TableAvailability, string> = {
  AVAILABLE: "Available",
  OCCUPIED: "Occupied",
  DIRTY: "Dirty",
  OUT_OF_SERVICE: "Out of service",
  INACTIVE: "Inactive",
};

/** Distinct by border and fill, and the label always says it in words too. */
export const AVAILABILITY_STYLES: Record<TableAvailability, string> = {
  AVAILABLE: "border-emerald-500 bg-emerald-50",
  OCCUPIED: "border-blue-500 bg-blue-50",
  DIRTY: "border-amber-500 bg-amber-50",
  OUT_OF_SERVICE: "border-red-500 bg-red-50",
  INACTIVE: "border-neutral-300 bg-neutral-100",
};

export const WARNING_LABELS: Record<string, string> = {
  SERVER_NEEDS_REASSIGNMENT: "This server needs reassigning",
  OVER_CAPACITY: "Seated over capacity",
};

export function elapsedLabel(seatedAt: Date, now: Date): string {
  const minutes = Math.max(0, Math.floor((+now - +seatedAt) / 60_000));

  return minutes < 60
    ? `${minutes} min`
    : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
