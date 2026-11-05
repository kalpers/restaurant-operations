import type { DatabaseExecutor } from "@/db/transactions/transaction-context";
import { AuthorizationError } from "@/shared/errors/app-error";

import type { PermissionCode } from "../permission-catalog";
import {
  findEffectiveGrants,
  findUserIdentity,
} from "../repositories/auth-context-repository";
import type { Actor, AuthContext, AuthorizedLocation } from "../types";

/**
 * Resolves a user's current access from the database. Returns null for an unknown or
 * disabled user, so a still-valid session token grants nothing.
 */
export async function getUserAuthContext(
  executor: DatabaseExecutor,
  userId: string,
): Promise<AuthContext | null> {
  const user = await findUserIdentity(executor, userId);

  if (!user?.active) {
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
