import { and, eq, gte, isNull, lte, or, sql } from "drizzle-orm";

import { certificationTypes, employeeCertifications, employeeLocations, employees } from "@/db/schema";
import type { DatabaseExecutor } from "@/db/transactions/transaction-context";

/**
 * Phase 20 (policy 14, D11): certifications of ACTIVE employees at the location that expire
 * within their type's `warning_days`, from `today` (a local calendar date) through the
 * expiration date. Names and dates only: no certificate numbers or documents.
 */
export async function findCertificationsInWarningWindow(
  executor: DatabaseExecutor,
  input: { organizationId: string; locationId: string; today: string },
) {
  return executor
    .selectDistinct({
      certificationId: employeeCertifications.id,
      employeeId: employees.id,
      userId: employees.userId,
      typeName: certificationTypes.name,
      expirationDate: employeeCertifications.expirationDate,
    })
    .from(employeeCertifications)
    .innerJoin(employees, eq(employees.id, employeeCertifications.employeeId))
    .innerJoin(certificationTypes, eq(certificationTypes.id, employeeCertifications.certificationTypeId))
    .innerJoin(
      employeeLocations,
      and(
        eq(employeeLocations.employeeId, employees.id),
        eq(employeeLocations.locationId, input.locationId),
        lte(employeeLocations.effectiveFrom, input.today),
        or(isNull(employeeLocations.effectiveTo), gte(employeeLocations.effectiveTo, input.today)),
      ),
    )
    .where(
      and(
        eq(employees.organizationId, input.organizationId),
        eq(employees.employmentStatus, "ACTIVE"),
        eq(certificationTypes.active, true),
        sql`${certificationTypes.warningDays} IS NOT NULL`,
        sql`${employeeCertifications.expirationDate} IS NOT NULL`,
        gte(employeeCertifications.expirationDate, input.today),
        sql`${employeeCertifications.expirationDate} - ${certificationTypes.warningDays} <= ${input.today}::date`,
      ),
    );
}
