import type { Database } from "@/db";
import { employeePositionCompensation } from "@/db/schema";

/** A wage row, so a test can prove Scheduling neither reads nor exposes it. */
export async function saveCompensationForTest(
  database: Database,
  scenario: { organizationId: string; server: string; owner: { userId: string } },
  employeeId: string,
  hourlyRate: string,
): Promise<void> {
  await database.insert(employeePositionCompensation).values({
    organizationId: scenario.organizationId,
    employeeId,
    positionId: scenario.server,
    compensationType: "HOURLY",
    hourlyRate,
    effectiveFrom: "2024-01-15",
    createdByUserId: scenario.owner.userId,
  });
}
