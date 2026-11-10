import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";

import { getDatabase } from "@/db";
import { AuthenticationError, AuthorizationError } from "@/shared/errors/app-error";

import type { PermissionCode } from "./permission-catalog";
import {
  getUserAuthContext,
  hasPermission,
  requirePermission,
} from "./services/permission-service";
import { getSessionIdentity } from "./session";
import type { Actor, AuthContext, AuthorizedLocation } from "./types";

export const CURRENT_LOCATION_COOKIE = "restaurant_ops_location";

export const PASSWORD_CHANGE_PATH = "/account/password";

/**
 * The current user, resolved from the database. Null when signed out, disabled, deleted,
 * or signed in before their last password change. Cached for one render so a layout and its
 * page share a single lookup.
 */
export const getCurrentAuth = cache(async (): Promise<AuthContext | null> => {
  const identity = await getSessionIdentity();

  return identity
    ? getUserAuthContext(getDatabase(), identity.userId, {
        session: identity.authTime === undefined ? {} : { authTime: identity.authTime },
      })
    : null;
});

/**
 * For the password-change endpoint only: the signed-in user even while a forced change is
 * pending. Throws an error that maps to 401.
 */
export async function requireCurrentUserAllowingPasswordChange(): Promise<AuthContext> {
  const auth = await getCurrentAuth();

  if (!auth) {
    throw new AuthenticationError();
  }

  return auth;
}

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

/**
 * For Route Handlers. Throws an error that maps to 401, or 403 `PASSWORD_CHANGE_REQUIRED`
 * while an administrator's reset is pending (every API guard goes through here).
 */
export async function requireCurrentUser(): Promise<AuthContext> {
  const auth = await requireCurrentUserAllowingPasswordChange();

  if (auth.mustChangePassword) {
    throw new AuthorizationError(
      "Change your password before continuing.",
      "PASSWORD_CHANGE_REQUIRED",
    );
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

/**
 * For Route Handlers whose service decides among several permissions, such as self-service
 * or manager access. Every such service asserts what it needs: this only says who is
 * acting and where. Throws errors that map to 401 and 403.
 */
export async function requireApiActor(): Promise<Actor> {
  const auth = await requireCurrentUser();
  const location = await resolveCurrentLocation(auth);

  if (!location) {
    throw new AuthorizationError();
  }

  return {
    userId: auth.userId,
    organizationId: location.organizationId,
    locationId: location.locationId,
    permissions: new Set(location.permissions),
  };
}

/** For the password-change page only. Signed-out users go to the login page. */
export async function requirePageUserAllowingPasswordChange(): Promise<AuthContext> {
  const auth = await getCurrentAuth();

  if (!auth) {
    redirect("/login");
  }

  return auth;
}

/**
 * For pages. Signed-out users go to the login page; a user with a pending forced change goes
 * to the password-change page (every page guard goes through here).
 */
export async function requirePageUser(): Promise<AuthContext> {
  const auth = await requirePageUserAllowingPasswordChange();

  if (auth.mustChangePassword) {
    redirect(PASSWORD_CHANGE_PATH);
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

/** For pages reachable with any one of several permissions. */
export async function requirePageActorWithAny(
  permissions: readonly PermissionCode[],
): Promise<{
  auth: AuthContext;
  location: AuthorizedLocation;
  actor: Actor;
}> {
  const auth = await requirePageUser();
  const location = await resolveCurrentLocation(auth);
  const held = permissions.find(
    (permission) =>
      location && hasPermission(auth, permission, location.locationId),
  );

  if (!location || !held) {
    redirect("/access-denied");
  }

  return {
    auth,
    location,
    actor: requirePermission(auth, {
      permission: held,
      locationId: location.locationId,
    }),
  };
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
