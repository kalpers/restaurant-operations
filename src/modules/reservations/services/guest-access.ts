import type { PermissionCode } from "@/modules/auth/permission-catalog";
import type { Actor } from "@/modules/auth/types";
import { AuthorizationError } from "@/shared/errors/app-error";

/** Every guest service calls this itself, so a request is refused however it's reached. */
export function assertPermission(actor: Actor, permission: PermissionCode): void {
  if (!actor.permissions.has(permission)) {
    throw new AuthorizationError();
  }
}

/** Refuses unless the actor holds at least one of the permissions. */
export function assertAnyPermission(actor: Actor, permissions: readonly PermissionCode[]): void {
  if (!permissions.some((permission) => actor.permissions.has(permission))) {
    throw new AuthorizationError();
  }
}

export function actorHolds(actor: Actor, permission: PermissionCode): boolean {
  return actor.permissions.has(permission);
}
