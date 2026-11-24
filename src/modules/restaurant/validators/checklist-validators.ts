import { z } from "zod";

import { CHECKLIST_ITEM_STATES, CHECKLIST_KINDS } from "@/db/schema/checklists";

// Phase 36 part 1 shape only. Business rules are in the checklist service, and PostgreSQL has
// the final word.

const expectedVersion = z.int().positive();
const kind = z.enum(CHECKLIST_KINDS);

const templateFields = {
  name: z.string().trim().min(1).max(80),
  kind,
  requiresSignOff: z.boolean().default(false),
  positionIds: z.array(z.uuid()).max(50).default([]),
  items: z
    .array(
      z.object({
        id: z.uuid().nullable().optional(),
        text: z.string().trim().min(1).max(200),
        required: z.boolean().default(true),
        active: z.boolean().default(true),
      }),
    )
    .min(1)
    .max(100),
};

export const createChecklistTemplateSchema = z.object(templateFields);

export const updateChecklistTemplateSchema = z.object({ ...templateFields, active: z.boolean(), expectedVersion });

export const checklistTemplateIdParamsSchema = z.object({ templateId: z.uuid() });

export const startChecklistRunSchema = z.object({
  templateId: z.uuid(),
  employeeId: z.uuid().nullable().optional(),
});

export const checklistRunIdParamsSchema = z.object({ runId: z.uuid() });

export const checklistItemIdParamsSchema = z.object({ itemId: z.uuid() });

export const setChecklistItemSchema = z.object({
  state: z.enum(CHECKLIST_ITEM_STATES),
  skipReason: z.string().max(200).nullable().optional(),
  note: z.string().max(500).nullable().optional(),
  expectedVersion,
});

export const checklistRunVersionSchema = z.object({ expectedVersion });

export const checklistHistoryQuerySchema = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
  templateId: z.uuid().optional(),
  kind: kind.optional(),
});
