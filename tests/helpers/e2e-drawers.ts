import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { getDatabase } from "../../src/db";
import { cashDrawers, cashDrawerSessions, users } from "../../src/db/schema";
import { ALL_PERMISSION_CODES } from "../../src/modules/auth/permission-catalog";
import type { Actor } from "../../src/modules/auth/types";
import { createDrawer, openDrawerSession } from "../../src/modules/settlements/services/drawer-service";

/** The shared E2E drawer on the seeded main location (Phase 17 decision 8). */
export const E2E_DRAWER_CODE = "E2E";

/**
 * The shared drawer is opened by a dedicated, disabled "keeper" user that no spec's cleanup
 * removes. Its open session holds an idempotency record, which would otherwise block a
 * spec's cleanup from deleting that spec's own users' records.
 */
const KEEPER_EMAIL = "drawer-keeper@e2e-drawers.example.test";

async function keeperUserId(): Promise<string> {
  const database = getDatabase();

  await database
    .insert(users)
    .values({ email: KEEPER_EMAIL, normalizedEmail: KEEPER_EMAIL, passwordHash: "!", active: false, disabledAt: new Date() })
    .onConflictDoNothing({ target: users.normalizedEmail });

  const [row] = await database.select({ id: users.id }).from(users).where(eq(users.normalizedEmail, KEEPER_EMAIL));

  return row!.id;
}

async function findOpenSession(locationId: string, drawerId: string) {
  const [open] = await getDatabase()
    .select({ id: cashDrawerSessions.id })
    .from(cashDrawerSessions)
    .where(
      and(
        eq(cashDrawerSessions.locationId, locationId),
        eq(cashDrawerSessions.drawerId, drawerId),
        eq(cashDrawerSessions.status, "OPEN"),
      ),
    );

  return open?.id ?? null;
}

/**
 * The open session of the shared "E2E" drawer at the actor's location, creating the drawer
 * and opening it on first use. Idempotent and safe when two workers race: a lost race reads
 * what the winner made. The seeded main location requires a drawer for cash (its settings
 * row was created after the Phase 17 migration), so cash in E2E goes here.
 */
export async function ensureE2eDrawerSession(actor: Actor): Promise<string> {
  const database = getDatabase();
  // Setup only: the keeper acts with every permission at the actor's location.
  const setup: Actor = { ...actor, userId: await keeperUserId(), permissions: new Set(ALL_PERMISSION_CODES) };
  const drawerOf = async () =>
    (
      await database
        .select({ id: cashDrawers.id })
        .from(cashDrawers)
        .where(and(eq(cashDrawers.locationId, actor.locationId), eq(cashDrawers.code, E2E_DRAWER_CODE)))
    )[0]?.id ?? null;
  let drawerId = await drawerOf();

  if (!drawerId) {
    drawerId = await createDrawer(database, setup, { code: E2E_DRAWER_CODE, name: "E2E register" })
      .then((drawer) => drawer.id)
      .catch(async () => (await drawerOf())!);
  }

  const open = await findOpenSession(actor.locationId, drawerId);

  if (open) {
    return open;
  }

  return openDrawerSession(database, setup, drawerId, { openingFloat: "100.00", idempotencyKey: `e2e-${randomUUID()}` })
    .then((session) => session.id)
    .catch(async () => (await findOpenSession(actor.locationId, drawerId!))!);
}
