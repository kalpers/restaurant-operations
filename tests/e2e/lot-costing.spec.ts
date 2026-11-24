import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";

import { getDatabase } from "../../src/db";
import { unitsOfMeasure } from "../../src/db/schema";
import { withTransaction } from "../../src/db/transactions/transaction-context";
import { getUserAuthContext, requirePermission } from "../../src/modules/auth/services/permission-service";
import { postInventoryTransaction } from "../../src/modules/inventory/services/posting-service";
import { createOwner, mainLocationId, shortCode, signedIn, stockedEverywhere } from "../helpers/e2e-locations";
import type { OrdersAccount } from "../helpers/e2e-orders";

// Phase 37: a manager turns on lot tracking and lot costing for cheese. Two deliveries at
// different prices become lots carried at their own cost; the Inventory page values the item
// by its lots; wasting the first lot to expire takes that lot's value out.

test.describe.configure({ mode: "serial" });

let owner: OrdersAccount;
let main: string;
let cheese: { id: string; name: string };

test.beforeAll(async () => {
  owner = await createOwner();
  main = await mainLocationId();
  const item = await stockedEverywhere(owner, `E2E Gouda ${shortCode("")}`, [main]);
  cheese = { id: item.id, name: item.name };
});

/** A delivery posted directly, as receiving would: `quantity` EACH for `totalCost`. */
async function deliver(quantity: string, totalCost: string, expiresOn: string) {
  const context = await getUserAuthContext(getDatabase(), owner.id);
  const actor = requirePermission(context!, { permission: "inventory.configure", locationId: main });
  const [each] = await getDatabase().select({ id: unitsOfMeasure.id }).from(unitsOfMeasure).where(eq(unitsOfMeasure.code, "EACH"));

  await withTransaction(getDatabase(), (transaction) =>
    postInventoryTransaction(transaction, {
      organizationId: actor.organizationId,
      locationId: main,
      inventoryItemId: cheese.id,
      type: "RECEIVE",
      quantity,
      unitOfMeasureId: each!.id,
      incomingTotalCost: totalCost,
      createdByUserId: actor.userId,
      lot: { expiresOn, supplierLotCode: null },
    }),
  );
}

test("the manager costs cheese by lot, and each delivery is carried at its own cost", async ({ browser }) => {
  const page = await signedIn(browser, owner, main);

  await page.goto(`/inventory/items/${cheese.id}`);
  const costing = page.getByRole("region", { name: "Costing" });
  await expect(costing).toContainText("Costing by lot needs lot tracking.");
  await page.getByRole("button", { name: "Turn lot tracking on" }).click();
  await expect(page.getByRole("button", { name: "Turn lot tracking off" })).toBeVisible({ timeout: 20_000 });

  await costing.getByRole("combobox", { name: /^Reason/ }).selectOption({ label: "Supplier prices change often" });
  await costing.getByRole("button", { name: "Cost by lot" }).click();
  await expect(page.getByText("Costing is by lot.")).toBeVisible({ timeout: 20_000 });
  await page.reload();
  await expect(costing.getByRole("button", { name: "Switch to weighted average" })).toBeVisible({ timeout: 20_000 });

  await deliver("2", "2.00", "2030-01-10");
  await deliver("3", "6.00", "2030-01-20");

  await page.goto("/inventory/lots");
  const lots = page.getByTestId("lot-row").filter({ hasText: cheese.name });
  await expect(lots).toHaveCount(2, { timeout: 20_000 });
  await expect(lots.first()).toContainText("carried at 1.0000 per EACH, worth 2.0000");
  await expect(lots.nth(1)).toContainText("carried at 2.0000 per EACH, worth 6.0000");

  await page.goto("/inventory");
  const row = page.getByRole("row", { name: `Stock ${cheese.name}` });
  await expect(row).toContainText("By lot");
  await expect(row).toContainText("$8.0000");
});

test("wasting the first lot to expire takes out that lot's value", async ({ browser }) => {
  const page = await signedIn(browser, owner, main);

  await page.goto("/inventory/lots");
  const first = page.getByTestId("lot-row").filter({ hasText: cheese.name }).first();
  await first.getByRole("button", { name: "Waste lot" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Waste lot" }).click();
  await expect(page.getByText("Lot wasted.")).toBeVisible({ timeout: 20_000 });

  await page.goto("/inventory");
  const row = page.getByRole("row", { name: `Stock ${cheese.name}` });
  await expect(row).toContainText("$6.0000", { timeout: 20_000 });
  await expect(row).toContainText(/\$2\.0000\s*on hand/);
});
