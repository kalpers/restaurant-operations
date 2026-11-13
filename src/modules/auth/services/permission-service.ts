import type { DatabaseExecutor } from "@/db/transactions/transaction-context";
import { AuthorizationError } from "@/shared/errors/app-error";

import type { PermissionCode } from "../permission-catalog";
import {
  findClosedLocationGrantRows,
  findEffectiveGrants,
  findUserIdentity,
} from "../repositories/auth-context-repository";
import type { Actor, AuthContext, AuthorizedLocation } from "../types";
import { isSessionCurrent } from "./session-validity";

/**
 * Resolves a user's current access from the database. Returns null for an unknown or
 * disabled user, so a still-valid session token grants nothing.
 *
 * Pass `session` when resolving a request's session: a session signed in before the user's
 * last password change is then treated like a disabled user's (Phase 16).
 */
export async function getUserAuthContext(
  executor: DatabaseExecutor,
  userId: string,
  options: { session?: { authTime?: number } } = {},
): Promise<AuthContext | null> {
  const user = await findUserIdentity(executor, userId);

  if (!user?.active) {
    return null;
  }

  if (options.session && !isSessionCurrent(options.session.authTime, user.passwordChangedAt)) {
    return null;
  }

  const grants = await findEffectiveGrants(executor, userId);
  const byLocation = new Map<string, AuthorizedLocation>();

  for (const grant of grants) {
    let location = byLocation.get(grant.locationId);

    if (!location) {
      location = {
        locationId: grant.locationId,
        locationCode: grant.locationCode,
        locationName: grant.locationName,
        organizationId: grant.organizationId,
        roles: [],
        permissions: [],
      };
      byLocation.set(grant.locationId, location);
    }

    if (!location.roles.some((role) => role.id === grant.roleId)) {
      location.roles.push({
        id: grant.roleId,
        code: grant.roleCode,
        name: grant.roleName,
      });
    }

    const code = grant.permissionCode as PermissionCode | null;

    if (code && !location.permissions.includes(code)) {
      location.permissions.push(code);
    }
  }

  return {
    userId: user.id,
    email: user.email,
    active: true,
    mustChangePassword: user.mustChangePassword,
    locations: [...byLocation.values()],
  };
}

export function getPermissionsAt(
  context: AuthContext,
  locationId: string,
): readonly PermissionCode[] {
  return (
    context.locations.find((location) => location.locationId === locationId)
      ?.permissions ?? []
  );
}

export function hasPermission(
  context: AuthContext,
  permission: PermissionCode,
  locationId: string,
): boolean {
  return getPermissionsAt(context, locationId).includes(permission);
}

/** Permission at one location never implies permission at another. */
export function requirePermission(
  context: AuthContext,
  request: { permission: PermissionCode; locationId: string },
): Actor {
  const location = context.locations.find(
    (candidate) => candidate.locationId === request.locationId,
  );

  if (!location?.permissions.includes(request.permission)) {
    throw new AuthorizationError();
  }

  return {
    userId: context.userId,
    organizationId: location.organizationId,
    locationId: location.locationId,
    permissions: new Set(location.permissions),
  };
}

/** A direct database-backed check, for callers without a resolved context. */
export async function userHasPermission(
  executor: DatabaseExecutor,
  request: { userId: string; permission: PermissionCode; locationId: string },
): Promise<boolean> {
  const context = await getUserAuthContext(executor, request.userId);

  return context !== null
    ? hasPermission(context, request.permission, request.locationId)
    : false;
}

/**
 * Phase 23 (policy 7): what the user's still-active role assignments grant at the
 * organization's *closed* locations. Used only to keep a closed location's history in
 * reports; these grants count nowhere else, and the reporting service also requires the same
 * permission at an open location.
 */
export async function findClosedLocationReportGrants(
  executor: DatabaseExecutor,
  userId: string,
  organizationId: string,
): Promise<AuthorizedLocation[]> {
  const rows = await findClosedLocationGrantRows(executor, userId, organizationId);
  const byLocation = new Map<string, AuthorizedLocation>();

  for (const row of rows) {
    const entry =
      byLocation.get(row.locationId) ??
      ({
        locationId: row.locationId,
        locationCode: row.locationCode,
        locationName: row.locationName,
        organizationId,
        roles: [],
        permissions: [],
      } satisfies AuthorizedLocation);

    if (!entry.permissions.includes(row.permissionCode as PermissionCode)) {
      entry.permissions.push(row.permissionCode as PermissionCode);
    }

    byLocation.set(row.locationId, entry);
  }

  return [...byLocation.values()];
}
