import { z } from "zod";

import { MAXIMUM_PASSWORD_LENGTH, MINIMUM_PASSWORD_LENGTH } from "../password";

const expectedVersion = z.int().positive();

export const credentialsSchema = z.object({
  email: z.string().min(1).max(320),
  password: z.string().min(1).max(MAXIMUM_PASSWORD_LENGTH),
});

export const createUserSchema = z.object({
  email: z.email().max(320),
  password: z.string().min(MINIMUM_PASSWORD_LENGTH).max(MAXIMUM_PASSWORD_LENGTH),
  roleId: z.uuid(),
});

export const setActiveSchema = z.object({
  active: z.boolean(),
  expectedVersion,
});

export const assignRoleSchema = z.object({ roleId: z.uuid() });

export const createRoleSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[A-Z][A-Z0-9_]{1,49}$/),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).nullable(),
});

export const replaceRolePermissionsSchema = z.object({
  permissions: z.array(z.string().max(100)).max(500),
  expectedVersion,
});

export const selectLocationSchema = z.object({ locationId: z.uuid() });

export const userIdParamsSchema = z.object({ userId: z.uuid() });
export const roleIdParamsSchema = z.object({ roleId: z.uuid() });
export const userRoleParamsSchema = z.object({
  userId: z.uuid(),
  roleId: z.uuid(),
});

/** Shape only; length rules and the current-password check are in the password service. */
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(MAXIMUM_PASSWORD_LENGTH),
  newPassword: z.string().min(1).max(MAXIMUM_PASSWORD_LENGTH),
});

export const resetPasswordSchema = z.object({ expectedVersion });
