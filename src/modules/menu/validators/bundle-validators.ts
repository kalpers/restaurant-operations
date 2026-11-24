import { z } from "zod";

// Phase 36 part 5 shape only. Business rules are in the bundle service.

export const saveBundleSchema = z.object({
  expectedVersion: z.int().positive(),
  slots: z
    .array(
      z.object({
        id: z.uuid().nullable().optional(),
        name: z.string().trim().min(1).max(60),
        defaultCourse: z.int().min(1).max(5),
        minimumChoices: z.int().min(0).max(10),
        maximumChoices: z.int().min(1).max(10),
        options: z
          .array(
            z.object({
              componentMenuItemId: z.uuid(),
              upcharge: z.string().trim().regex(/^\d{1,8}(\.\d{1,2})?$/),
              isDefault: z.boolean().optional(),
            }),
          )
          .min(1)
          .max(50),
      }),
    )
    .min(1)
    .max(10),
});

export const clearBundleSchema = z.object({ expectedVersion: z.int().positive() });
