import { and, eq } from "drizzle-orm";

import { menuItems } from "@/db/schema";
import type { DatabaseExecutor } from "@/db/transactions/transaction-context";
import type { PermissionCode } from "@/modules/auth/permission-catalog";
import type { Actor } from "@/modules/auth/types";
import { AuthorizationError, NotFoundError } from "@/shared/errors/app-error";

export function actorHolds(actor: Actor, permission: PermissionCode): boolean {
  return actor.permissions.has(permission);
}

/** Every service calls this itself, so a request is refused however it's reached. */
export function assertPermission(actor: Actor, permission: PermissionCode): void {
  if (!actorHolds(actor, permission)) {
    throw new AuthorizationError();
  }
}

/** Passes when the actor holds any one of the permissions. */
export function assertAnyPermission(
  actor: Actor,
  permissions: readonly PermissionCode[],
): void {
  if (!permissions.some((permission) => actorHolds(actor, permission))) {
    throw new AuthorizationError();
  }
}

/** A menu item in the actor's organization, or "not found": other tenants look absent. */
export async function requireMenuItem(
  executor: DatabaseExecutor,
  actor: Actor,
  menuItemId: string,
): Promise<{ id: string; organizationId: string }> {
  const [item] = await executor
    .select({ id: menuItems.id, organizationId: menuItems.organizationId })
    .from(menuItems)
    .where(
      and(eq(menuItems.id, menuItemId), eq(menuItems.organizationId, actor.organizationId)),
    );

  if (!item) {
    throw new NotFoundError("menu item");
  }

  return item;
}
