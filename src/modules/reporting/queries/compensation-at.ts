import { sql, type SQL } from "drizzle-orm";

/**
 * `LEFT JOIN LATERAL (...) c ON true`: the compensation in effect on a date for an Employee
 * and the Position worked (approved Phase 12 policy; effective dates inclusive, latest start
 * wins). Selects `c.compensation_type` and `c.hourly_rate`. Scheduled and actual labor both
 * use this one lookup.
 */
export function compensationAt(employeeId: SQL, positionId: SQL, onDate: SQL): SQL {
  return sql`LEFT JOIN LATERAL (
    SELECT epc.compensation_type, epc.hourly_rate
    FROM employee_position_compensation epc
    WHERE epc.employee_id = ${employeeId}
      AND epc.position_id = ${positionId}
      AND epc.effective_from <= ${onDate}
      AND (epc.effective_to IS NULL OR epc.effective_to >= ${onDate})
    ORDER BY epc.effective_from DESC
    LIMIT 1
  ) c ON true`;
}
