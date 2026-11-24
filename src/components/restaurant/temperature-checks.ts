import type { CheckDue } from "@/modules/restaurant/services/temperature-service";

/** Phase 36 (policy 6): a check due, with its time as text so it crosses to the browser unchanged. */
export type ClientCheck = Omit<CheckDue, "status"> & { status: { state: "NO_SCHEDULE" | "OK" | "OVERDUE"; dueAt: string | null } };

export function toClientChecks(checks: readonly CheckDue[]): ClientCheck[] {
  return checks.map((check) => ({
    ...check,
    status: { state: check.status.state, dueAt: "dueAt" in check.status ? check.status.dueAt.toISOString() : null },
  }));
}
