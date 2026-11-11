import type { Database } from "@/db";
import { withTransaction } from "@/db/transactions/transaction-context";
import { disableUserForTermination } from "@/modules/auth/services/user-service";
import type { Actor } from "@/modules/auth/types";
import {
  assertNotTerminated,
  assertPermission,
  assertVersion,
  lockEmployee,
} from "@/modules/employees/services/access";
import { recordTermination } from "@/modules/employees/services/status-service";
import { isOnTheClock } from "@/modules/scheduling/queries/worked-time";
import { BusinessRuleError } from "@/shared/errors/app-error";

/**
 * Crosses Employees and Auth in one transaction, so a terminated employee can't keep
 * access through a linked account. If the account can't be disabled under the Phase 2
 * safeguards (last Owner, the actor's own account, or permissions the actor lacks),
 * the whole termination is refused. This is business logic in a service by design, not
 * a database trigger.
 */
export async function terminateEmployee(
  database: Database,
  actor: Actor,
  input: {
    employeeId: string;
    terminationDate: string;
    reason: string | null;
    expectedVersion: number;
  },
): Promise<{ id: string; version: number }> {
  assertPermission(actor, "employees.terminate");

  return withTransaction(database, async (transaction) => {
    const employee = await lockEmployee(transaction, actor, input.employeeId);

    assertVersion(employee, input.expectedVersion);
    assertNotTerminated(employee);

    // Phase 18 policy A10: clock them out first, so no entry is left open forever.
    if (await isOnTheClock(transaction, employee.id)) {
      throw new BusinessRuleError(
        "EMPLOYEE_ON_CLOCK",
        "This employee is on the clock. Clock them out before terminating them.",
      );
    }

    if (employee.userId) {
      await disableUserForTermination(transaction, actor, employee.userId);
    }

    return recordTermination(transaction, actor, employee, input);
  });
}
