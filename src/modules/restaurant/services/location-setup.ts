import { and, asc, eq, inArray } from "drizzle-orm";

import { checklistTemplateItems, checklistTemplatePositions, checklistTemplates, temperaturePoints } from "@/db/schema";
import type { DatabaseTransaction } from "@/db/transactions/transaction-context";

/**
 * Phase 36 (policy 4, `CHECKLISTS`): the source's active checklist templates, with their
 * active items and positions. Never runs.
 */
export async function copyChecklistTemplates(
  transaction: DatabaseTransaction,
  input: { organizationId: string; fromLocationId: string; toLocationId: string; userId: string },
): Promise<number> {
  const templates = await transaction
    .select()
    .from(checklistTemplates)
    .where(and(eq(checklistTemplates.locationId, input.fromLocationId), eq(checklistTemplates.active, true)))
    .orderBy(asc(checklistTemplates.name));

  if (templates.length === 0) {
    return 0;
  }

  const ids = templates.map((template) => template.id);
  const [items, positions] = await Promise.all([
    transaction
      .select()
      .from(checklistTemplateItems)
      .where(and(inArray(checklistTemplateItems.templateId, ids), eq(checklistTemplateItems.active, true)))
      .orderBy(asc(checklistTemplateItems.sortOrder)),
    transaction.select().from(checklistTemplatePositions).where(inArray(checklistTemplatePositions.templateId, ids)),
  ]);

  for (const template of templates) {
    const [created] = await transaction
      .insert(checklistTemplates)
      .values({
        organizationId: input.organizationId,
        locationId: input.toLocationId,
        name: template.name,
        kind: template.kind,
        requiresSignOff: template.requiresSignOff,
        createdByUserId: input.userId,
        updatedByUserId: input.userId,
      })
      .returning({ id: checklistTemplates.id });
    const own = items.filter((item) => item.templateId === template.id);
    const targets = positions.filter((position) => position.templateId === template.id);

    if (own.length > 0) {
      await transaction.insert(checklistTemplateItems).values(
        own.map((item) => ({
          templateId: created!.id,
          organizationId: input.organizationId,
          text: item.text,
          required: item.required,
          sortOrder: item.sortOrder,
        })),
      );
    }

    if (targets.length > 0) {
      await transaction
        .insert(checklistTemplatePositions)
        .values(targets.map((target) => ({ templateId: created!.id, positionId: target.positionId, organizationId: input.organizationId })));
    }
  }

  return templates.length;
}

/** Phase 36 (policy 4, `TEMPERATURE_POINTS`): the source's active check points. Never readings. */
export async function copyTemperaturePoints(
  transaction: DatabaseTransaction,
  input: { organizationId: string; fromLocationId: string; toLocationId: string; userId: string },
): Promise<number> {
  const points = await transaction
    .select()
    .from(temperaturePoints)
    .where(and(eq(temperaturePoints.locationId, input.fromLocationId), eq(temperaturePoints.active, true)));

  if (points.length > 0) {
    await transaction.insert(temperaturePoints).values(
      points.map((point) => ({
        organizationId: input.organizationId,
        locationId: input.toLocationId,
        name: point.name,
        kind: point.kind,
        unit: point.unit,
        minimumValue: point.minimumValue,
        maximumValue: point.maximumValue,
        checkIntervalMinutes: point.checkIntervalMinutes,
        sortOrder: point.sortOrder,
        createdByUserId: input.userId,
        updatedByUserId: input.userId,
      })),
    );
  }

  return points.length;
}
