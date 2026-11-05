import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";

import { getDatabase } from "@/db";
import { AuthenticationError } from "@/shared/errors/app-error";

import type { PermissionCode } from "./permission-catalog";
import {
  getUserAuthContext,
  hasPermission,
  requirePermission,
} from "./services/permission-service";
import { getSessionUserId } from "./session";
import type { Actor, AuthContext, AuthorizedLocation } from "./types";

export const CURRENT_LOCATION_COOKIE = "restaurant_ops_location";

/**
 * The current user, resolved from the database. Null when signed out, disabled or
 * deleted. Cached for one render so a layout and its page share a single lookup.
 */
export const getCurrentAuth = cache(async (): Promise<AuthContext | null> => {
  const userId = await getSessionUserId();

  return userId ? getUserAuthContext(getDatabase(), userId) : null;
});

/**
 * The location being worked at. The cookie is only a preference: it counts only if the
 * user is authorized there now, and otherwise the first authorized location is used.
 */
export async function resolveCurrentLocation(
  auth: AuthContext,
): Promise<AuthorizedLocation | null> {
  const selected = (await cookies()).get(CURRENT_LOCATION_COOKIE)?.value;

  return (
    auth.locations.find((location) => location.locationId === selected) ??
    auth.locations[0] ??
    null
  );
}

/** For Route Handlers. Throws an error that maps to 401. */
export async function requireCurrentUser(): Promise<AuthContext> {
  const auth = await getCurrentAuth();

  if (!auth) {
    throw new AuthenticationError();
  }

  return auth;
}

/**
 * For Route Handlers. Pass `locationId` when the request targets a specific location;
 * otherwise the current location is used. Throws errors that map to 401 and 403.
 */
export async function requireApiPermission(
  permission: PermissionCode,
  locationId?: string,
): Promise<Actor> {
  const auth = await requireCurrentUser();
  const targetLocationId =
    locationId ?? (await resolveCurrentLocation(auth))?.locationId ?? "";

  return requirePermission(auth, { permission, locationId: targetLocationId });
}

/** For pages. Signed-out users go to the login page. */
export async function requirePageUser(): Promise<AuthContext> {
  const auth = await getCurrentAuth();

  if (!auth) {
    redirect("/login");
  }

  return auth;
}

/** For pages. Each page calls this itself: a hidden link or a layout is not a guard. */
export async function requirePagePermission(permission: PermissionCode): Promise<{
  auth: AuthContext;
  location: AuthorizedLocation;
}> {
  const auth = await requirePageUser();
  const location = await resolveCurrentLocation(auth);

  if (!location || !hasPermission(auth, permission, location.locationId)) {
    redirect("/access-denied");
  }

  return { auth, location };
}

/** For pages whose services take an actor and enforce permissions themselves. */
export async function requirePageActor(permission: PermissionCode): Promise<{
  auth: AuthContext;
  location: AuthorizedLocation;
  actor: Actor;
}> {
  const { auth, location } = await requirePagePermission(permission);

  return {
    auth,
    location,
    actor: requirePermission(auth, {
      permission,
      locationId: location.locationId,
    }),
  };
}
