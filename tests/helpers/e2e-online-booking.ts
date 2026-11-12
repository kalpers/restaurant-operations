import { randomInt, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { eq, inArray, like } from "drizzle-orm";

import { closeDatabase, getDatabase } from "../../src/db";
import { locations, locationSettings, restaurantAreas, users } from "../../src/db/schema";

import { assignAt } from "./e2e-accounts";
import { createRoleAccount, type E2eScope, type OrdersAccount } from "./e2e-orders";
import { E2E_MESSAGE_CAPTURE_PATH } from "./e2e-storage";

// Phase 22 E2E: a location of this spec's own, so online booking settings and bookings never
// reach MAIN or another spec. Accounts are disabled afterwards; bookings stay as history.

export const ONLINE_SCOPE: E2eScope = {
  emailDomain: "online-e2e.example.test",
  rolePrefix: "ONLINE_E2E_",
  tablePrefix: "ONL-",
};

export type OnlineSetup = {
  locationId: string;
  /** The public code, lowercased, as in /book/{code}. */
  code: string;
  manager: OrdersAccount;
  host: OrdersAccount;
  suffix: string;
};

async function account(roleCode: string, locationId: string): Promise<OrdersAccount> {
  const created = await createRoleAccount(roleCode, ONLINE_SCOPE);

  await assignAt(created.id, roleCode, locationId);

  return created;
}

export async function createOnlineSetup(): Promise<OnlineSetup> {
  const database = getDatabase();
  const [main] = await database.select({ organizationId: locations.organizationId }).from(locations).where(eq(locations.locationCode, "MAIN"));
  const suffix = randomUUID().slice(0, 6);
  const code = `ONL_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const [location] = await database
    .insert(locations)
    .values({
      organizationId: main!.organizationId,
      name: `Harbor E2E ${suffix}`,
      locationCode: code,
      timezone: "America/Detroit",
      phone: "(555) 010-2000",
    })
    .returning({ id: locations.id });
  const locationId = location!.id;

  await database.insert(locationSettings).values({ locationId, cashDrawerRequired: false });
  await database.insert(restaurantAreas).values({ locationId, code: "DINING_ROOM", name: "Dining room", areaType: "DINING" });

  return {
    locationId,
    code: code.toLowerCase(),
    manager: await account("MANAGER", locationId),
    host: await account("HOST", locationId),
    suffix,
  };
}

/** A 555 number no other test uses, as typed and as E.164. */
export function uniquePhone(): { typed: string; e164: string } {
  const exchange = String(randomInt(200, 999));
  const line = String(randomInt(0, 10_000)).padStart(4, "0");

  return { typed: `(555) ${exchange}-${line}`, e164: `+1555${exchange}${line}` };
}

export type CapturedMessage = { id: string; channel: "SMS" | "EMAIL"; to: string; subject: string | null; body: string };

/** Messages the capture adapter wrote for one address (E.164 or email). */
export async function capturedFor(address: string): Promise<CapturedMessage[]> {
  let files: string[];

  try {
    files = await readdir(E2E_MESSAGE_CAPTURE_PATH);
  } catch {
    return [];
  }

  const messages = await Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .map(async (file) => JSON.parse(await readFile(path.join(E2E_MESSAGE_CAPTURE_PATH, file), "utf8")) as CapturedMessage),
  );

  return messages.filter((message) => message.to === address);
}

export async function disableOnlineAccounts(): Promise<void> {
  const database = getDatabase();
  const accounts = await database.select({ id: users.id }).from(users).where(like(users.normalizedEmail, `%@${ONLINE_SCOPE.emailDomain}`));

  if (accounts.length > 0) {
    await database
      .update(users)
      .set({ active: false, disabledAt: new Date() })
      .where(inArray(users.id, accounts.map((row) => row.id)));
  }

  await closeDatabase();
}
