import type { PermissionCode } from "@/modules/auth/permission-catalog";
import type { Actor } from "@/modules/auth/types";
import { AuthorizationError } from "@/shared/errors/app-error";

export function actorHolds(actor: Actor, permission: PermissionCode): boolean {
  return actor.permissions.has(permission);
}

/** Every service calls this itself, so a request is refused however it's reached. */
export function assertPermission(actor: Actor, permission: PermissionCode): void {
  if (!actorHolds(actor, permission)) {
    throw new AuthorizationError();
  }
}

export function assertAnyPermission(actor: Actor, permissions: readonly PermissionCode[]): void {
  if (!permissions.some((permission) => actorHolds(actor, permission))) {
    throw new AuthorizationError();
  }
}

/** Cost and valuation are shown only to holders of `inventory.cost.view`. */
export function canSeeCost(actor: Actor): boolean {
  return actorHolds(actor, "inventory.cost.view");
}
