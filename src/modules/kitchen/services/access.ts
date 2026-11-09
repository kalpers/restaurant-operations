import type { PermissionCode } from "@/modules/auth/permission-catalog";
import type { Actor } from "@/modules/auth/types";
import { AuthorizationError } from "@/shared/errors/app-error";

import { STATION_SCOPE, WORK_STATION_TYPES, type StationType } from "../types";

// Kitchen authorization: a location permission for the action, plus the station-type scope
// (`kitchen.*` for KITCHEN stations, `bar.*` for BAR stations). Every service checks it
// itself; hidden buttons and client filters are never the boundary.

export function canViewStationType(actor: Actor, type: StationType): boolean {
  return actor.permissions.has(STATION_SCOPE[type].view);
}

export function canWorkStationType(actor: Actor, type: StationType): boolean {
  return actor.permissions.has(STATION_SCOPE[type].manage);
}

export function viewableStationTypes(actor: Actor): StationType[] {
  return WORK_STATION_TYPES.filter((type) => canViewStationType(actor, type));
}

export function assertCanViewStationType(actor: Actor, type: StationType): void {
  if (!canViewStationType(actor, type)) {
    throw new AuthorizationError();
  }
}

export function assertCanWorkStationType(actor: Actor, type: string): void {
  if (!(type === "KITCHEN" || type === "BAR") || !canWorkStationType(actor, type)) {
    throw new AuthorizationError();
  }
}

export function assertKitchenPermission(actor: Actor, permission: PermissionCode): void {
  if (!actor.permissions.has(permission)) {
    throw new AuthorizationError();
  }
}
