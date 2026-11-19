import { eq } from "drizzle-orm";

import { loadLocalEnv, pointAtTestDatabase } from "../../src/config/tooling-env";
import { getDatabase } from "../../src/db";
import { locations } from "../../src/db/schema";
import { getUserAuthContext, requirePermission } from "../../src/modules/auth/services/permission-service";
import type { Actor } from "../../src/modules/auth/types";
import { createOrder } from "../../src/modules/orders/services/order-service";

import type { E2eScope, OrdersAccount } from "./e2e-orders";

loadLocalEnv();
pointAtTestDatabase();

// Phase 28 E2E: accounts and clock helpers for happy hour, exports and nutrition. Everything
// else goes through the shared orders helpers (menu, orders, settlement) and the real screens.

export const PHASE28_SCOPE: E2eScope = {
  emailDomain: "phase28-e2e.example.test",
  rolePrefix: "PHASE28_E2E_",
  tablePrefix: "P28-",
};

/** MAIN's time zone and the local wall-clock time `offsetMinutes` from now, "HH:MM". */
export async function mainLocalClock(offsetMinutes: number): Promise<string> {
  const [location] = await getDatabase()
    .select({ timezone: locations.timezone })
    .from(locations)
    .where(eq(locations.locationCode, "MAIN"));
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: location!.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const hour = Number(parts.find((part) => part.type === "hour")!.value);
  const minute = Number(parts.find((part) => part.type === "minute")!.value);
  const total = (((hour * 60 + minute + offsetMinutes) % 1440) + 1440) % 1440;

  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/** The account's actor at MAIN. */
export async function actorAtMain(account: OrdersAccount, permission: Parameters<typeof requirePermission>[1]["permission"]): Promise<Actor> {
  const [location] = await getDatabase().select({ id: locations.id }).from(locations).where(eq(locations.locationCode, "MAIN"));
  const context = await getUserAuthContext(getDatabase(), account.id);

  return requirePermission(context!, { permission, locationId: location!.id });
}

/** An empty takeout check opened by the account at MAIN, through the services. */
export async function emptyTakeout(account: OrdersAccount): Promise<string> {
  const order = await createOrder(getDatabase(), await actorAtMain(account, "orders.create"), { orderType: "TAKEOUT" });

  return order.id;
}
