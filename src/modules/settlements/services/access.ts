import type { PermissionCode } from "@/modules/auth/permission-catalog";
import type { Actor } from "@/modules/auth/types";
import { AuthorizationError } from "@/shared/errors/app-error";

export function actorHolds(actor: Actor, permission: PermissionCode): boolean {
  return actor.permissions.has(permission);
}

/** Every settlement service and workflow checks for itself, however the request arrives. */
export function assertPermission(actor: Actor, permission: PermissionCode): void {
  if (!actorHolds(actor, permission)) {
    throw new AuthorizationError();
  }
}
