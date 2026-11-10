import { and, eq } from "drizzle-orm";

import { readExplicitNodeEnv } from "../src/config/tooling-env";
import { getDatabase } from "../src/db";
import { locations, roles, userRoles } from "../src/db/schema";
import type { PermissionCode } from "../src/modules/auth/permission-catalog";
import { getUserAuthContext, requirePermission } from "../src/modules/auth/services/permission-service";
import type { Actor } from "../src/modules/auth/types";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Opt-in data scripts (`db:seed:demo`, `db:seed:validation`) add sample people and history.
 * They never remove anything, but that data doesn't belong in a shared database, so they
 * run only against a loopback DATABASE_URL with a non-production NODE_ENV.
 */
export function assertLocalDevelopment(what: string): void {
  const url = process.env.DATABASE_URL ?? "";
  let host = "";

  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    // An unreadable URL is refused below.
  }

  if (readExplicitNodeEnv() === "production" || !LOOPBACK.has(host)) {
    throw new Error(
      `${what} is for a local development database only: use a loopback DATABASE_URL and a non-production NODE_ENV.`,
    );
  }
}

/**
 * The bootstrapped Owner at MAIN, resolved through the normal permission service, so the
 * script acts as that Owner through the same services a person would use.
 */
export async function mainOwnerActor(permission: PermissionCode): Promise<Actor> {
  const database = getDatabase();
  const [location] = await database.select({ id: locations.id }).from(locations).where(eq(locations.locationCode, "MAIN"));
  const [owner] = location
    ? await database
        .select({ userId: userRoles.userId })
        .from(userRoles)
        .innerJoin(roles, eq(roles.id, userRoles.roleId))
        .where(and(eq(roles.code, "OWNER"), eq(userRoles.locationId, location.id)))
    : [];

  if (!location || !owner) {
    throw new Error("No Owner exists at MAIN. Run `npm run bootstrap:owner` first, then run this again.");
  }

  const context = await getUserAuthContext(database, owner.userId);

  return requirePermission(context!, { permission, locationId: location.id });
}
