import { and, asc, eq } from "drizzle-orm";

import { nextVersion } from "@/db/helpers/versioning";
import {
  positions,
  restaurantAreas,
  schedulingRules,
  staffingTemplateRequirements,
  staffingTemplates,
} from "@/db/schema";
import type { DatabaseExecutor } from "@/db/transactions/transaction-context";

export async function findRulesRow(
  executor: DatabaseExecutor,
  locationId: string,
) {
  const [row] = await executor
    .select()
    .from(schedulingRules)
    .where(eq(schedulingRules.locationId, locationId));

  return row;
}

export async function insertRulesRow(
  executor: DatabaseExecutor,
  values: typeof schedulingRules.$inferInsert,
) {
  const [row] = await executor
    .insert(schedulingRules)
    .values(values)
    .returning({ id: schedulingRules.id, version: schedulingRules.version });

  return row!;
}

export async function updateRulesRow(
  executor: DatabaseExecutor,
  input: { locationId: string; expectedVersion: number },
  changes: Partial<typeof schedulingRules.$inferInsert>,
) {
  return executor
    .update(schedulingRules)
    .set({ ...changes, version: nextVersion(schedulingRules.version) })
    .where(
      and(
        eq(schedulingRules.locationId, input.locationId),
        eq(schedulingRules.version, input.expectedVersion),
      ),
    )
    .returning({ id: schedulingRules.id, version: schedulingRules.version });
}

export function findTemplates(executor: DatabaseExecutor, locationId: string) {
  return executor
    .select()
    .from(staffingTemplates)
    .where(eq(staffingTemplates.locationId, locationId))
    .orderBy(asc(staffingTemplates.name));
}

export async function findTemplate(
  executor: DatabaseExecutor,
  templateId: string,
  locationId: string,
) {
  const [row] = await executor
    .select()
    .from(staffingTemplates)
    .where(
      and(
        eq(staffingTemplates.id, templateId),
        eq(staffingTemplates.locationId, locationId),
      ),
    );

  return row;
}

export async function insertTemplate(
  executor: DatabaseExecutor,
  values: typeof staffingTemplates.$inferInsert,
) {
  const [row] = await executor
    .insert(staffingTemplates)
    .values(values)
    .returning({ id: staffingTemplates.id, version: staffingTemplates.version });

  return row!;
}

export async function updateTemplateRow(
  executor: DatabaseExecutor,
  input: { id: string; locationId: string; expectedVersion: number },
  changes: Partial<typeof staffingTemplates.$inferInsert>,
) {
  return executor
    .update(staffingTemplates)
    .set({ ...changes, version: nextVersion(staffingTemplates.version) })
    .where(
      and(
        eq(staffingTemplates.id, input.id),
        eq(staffingTemplates.locationId, input.locationId),
        eq(staffingTemplates.version, input.expectedVersion),
      ),
    )
    .returning({ id: staffingTemplates.id, version: staffingTemplates.version });
}

export function findRequirements(executor: DatabaseExecutor, templateId: string) {
  return executor
    .select({
      id: staffingTemplateRequirements.id,
      staffingTemplateId: staffingTemplateRequirements.staffingTemplateId,
      dayOfWeek: staffingTemplateRequirements.dayOfWeek,
      positionId: staffingTemplateRequirements.positionId,
      positionName: positions.name,
      restaurantAreaId: staffingTemplateRequirements.restaurantAreaId,
      restaurantAreaName: restaurantAreas.name,
      startTime: staffingTemplateRequirements.startTime,
      endTime: staffingTemplateRequirements.endTime,
      requiredEmployeeCount: staffingTemplateRequirements.requiredEmployeeCount,
      priority: staffingTemplateRequirements.priority,
      active: staffingTemplateRequirements.active,
    })
    .from(staffingTemplateRequirements)
    .innerJoin(positions, eq(positions.id, staffingTemplateRequirements.positionId))
    .leftJoin(
      restaurantAreas,
      eq(restaurantAreas.id, staffingTemplateRequirements.restaurantAreaId),
    )
    .where(eq(staffingTemplateRequirements.staffingTemplateId, templateId))
    .orderBy(
      asc(staffingTemplateRequirements.dayOfWeek),
      asc(staffingTemplateRequirements.startTime),
      asc(positions.name),
    );
}

export async function insertRequirement(
  executor: DatabaseExecutor,
  values: typeof staffingTemplateRequirements.$inferInsert,
) {
  const [row] = await executor
    .insert(staffingTemplateRequirements)
    .values(values)
    .returning({ id: staffingTemplateRequirements.id });

  return row!;
}

export async function deactivateRequirementRow(
  executor: DatabaseExecutor,
  requirementId: string,
  templateId: string,
) {
  return executor
    .update(staffingTemplateRequirements)
    .set({ active: false })
    .where(
      and(
        eq(staffingTemplateRequirements.id, requirementId),
        eq(staffingTemplateRequirements.staffingTemplateId, templateId),
      ),
    )
    .returning({ id: staffingTemplateRequirements.id });
}

export async function findAreaAtLocation(
  executor: DatabaseExecutor,
  areaId: string,
  locationId: string,
) {
  const [row] = await executor
    .select({ id: restaurantAreas.id, active: restaurantAreas.active })
    .from(restaurantAreas)
    .where(
      and(
        eq(restaurantAreas.id, areaId),
        eq(restaurantAreas.locationId, locationId),
      ),
    );

  return row;
}

export function findAreas(executor: DatabaseExecutor, locationId: string) {
  return executor
    .select({ id: restaurantAreas.id, name: restaurantAreas.name })
    .from(restaurantAreas)
    .where(
      and(
        eq(restaurantAreas.locationId, locationId),
        eq(restaurantAreas.active, true),
      ),
    )
    .orderBy(asc(restaurantAreas.displayOrder));
}

export function findActivePositions(
  executor: DatabaseExecutor,
  organizationId: string,
) {
  return executor
    .select({ id: positions.id, name: positions.name })
    .from(positions)
    .where(
      and(
        eq(positions.organizationId, organizationId),
        eq(positions.active, true),
      ),
    )
    .orderBy(asc(positions.name));
}
