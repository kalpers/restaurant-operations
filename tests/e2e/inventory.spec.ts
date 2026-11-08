import { expect, test, type Page } from "@playwright/test";

import {
  createPermissionAccount,
  createRoleAccount,
  createStockedItem,
  createSupplierFor,
  ledgerRowsFor,
  removeInventoryE2eData,
  uniqueCode,
  type InventoryAccount,
} from "../helpers/e2e-inventory";

async function signIn(page: Page, account: InventoryAccount) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

const stockRow = (page: Page, name: string) => page.getByRole("row", { name: `Stock ${name}` });

test.afterAll(async () => {
  await removeInventoryE2eData();
});

test.describe("inventory receiving", () => {
  test("a submitted order changes no stock; receipts do, partially then fully", async ({ page }) => {
    const manager = await createRoleAccount("MANAGER");
    const name = `E2E Vodka ${uniqueCode().slice(-6)}`;
    const vodka = await createStockedItem(manager, {
      name,
      baseUnit: "ML",
      measurementType: "VOLUME",
      conversions: [
        { from: "CASE", to: "BOTTLE", factor: "12" },
        { from: "BOTTLE", to: "L", factor: "1" },
      ],
    });
    const supplierName = `E2E Spirits ${uniqueCode().slice(-6)}`;

    await createSupplierFor(manager, supplierName, [
      { inventoryItemId: vodka.id, purchaseUnit: "CASE", lastUnitCost: "300.0000" },
    ]);
    await signIn(page, manager);

    // Draft an order for 10 cases and submit it.
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Purchase orders", exact: true }).click();

    const create = page.getByRole("region", { name: "New purchase order" });

    await create.locator('select[name="supplierId"]').selectOption({ label: supplierName });
    await create.getByRole("button", { name: "Create draft order" }).click();

    const newest = page.getByRole("listitem", { name: /Purchase order PO-/ }).filter({ hasText: supplierName });

    await newest.getByRole("link", { name: /Open PO-/ }).click();

    const addLine = page.getByRole("region", { name: "Add a line" });

    await addLine.locator('select[name="supplierItemId"]').selectOption({ label: `${name} by the CASE` });
    await addLine.getByLabel("Quantity").fill("10");
    await addLine.getByRole("button", { name: "Add line" }).click();
    await expect(page.getByRole("listitem", { name: `Order line ${name}` })).toContainText("Ordered 10 CASE at $300.0000 = $3000.0000");

    await page.getByRole("button", { name: "Submit order" }).click();
    await expect(page.getByLabel("Order status")).toContainText("Submitted");
    expect(await ledgerRowsFor(vodka.id)).toEqual([]);

    // Receive 6 cases.
    const orderUrl = page.url();
    const receive = page.getByRole("form", { name: "Receive shipment" });

    await receive.getByLabel(`Received ${name} (CASE)`).fill("6");
    await receive.getByRole("button", { name: "Receive shipment" }).click();
    await expect(page.getByLabel("Order status")).toContainText("Partially received");
    await expect(page.getByRole("listitem", { name: `Order line ${name}` })).toContainText("received 6 · remaining 4");

    await page.goto("/inventory");
    await expect(stockRow(page, name)).toContainText("72000 ML");

    // Receive the remaining 4 at a different actual cost.
    await page.goto(orderUrl);
    await receive.getByLabel(`Received ${name} (CASE)`).fill("4");
    await receive.getByLabel(new RegExp(`Actual cost per CASE for ${name}`)).fill("330");
    await receive.getByRole("button", { name: "Receive shipment" }).click();
    await expect(page.getByLabel("Order status")).toContainText("Received");
    await expect(page.getByRole("region", { name: "Receipts" })).toContainText("at actual $330.0000 (ordered at $300.0000)");

    await page.goto("/inventory");
    await expect(stockRow(page, name)).toContainText("120000 ML");
    await expect(stockRow(page, name)).toContainText("$0.0260");
  });

  test("over-receiving is refused with a clear message", async ({ page }) => {
    const manager = await createRoleAccount("MANAGER");
    const name = `E2E Buns ${uniqueCode().slice(-6)}`;
    const buns = await createStockedItem(manager, {
      name,
      baseUnit: "EACH",
      conversions: [{ from: "PACK", to: "EACH", factor: "12" }],
    });
    const supplierName = `E2E Bakery ${uniqueCode().slice(-6)}`;

    await createSupplierFor(manager, supplierName, [{ inventoryItemId: buns.id, purchaseUnit: "PACK", lastUnitCost: "6.0000" }]);
    await signIn(page, manager);
    await page.goto("/purchasing/orders");

    const create = page.getByRole("region", { name: "New purchase order" });

    await create.locator('select[name="supplierId"]').selectOption({ label: supplierName });
    await create.getByRole("button", { name: "Create draft order" }).click();
    await page.getByRole("listitem", { name: /Purchase order PO-/ }).filter({ hasText: supplierName }).getByRole("link").click();

    const addLine = page.getByRole("region", { name: "Add a line" });

    await addLine.locator('select[name="supplierItemId"]').selectOption({ label: `${name} by the PACK` });
    await addLine.getByLabel("Quantity").fill("2");
    await addLine.getByRole("button", { name: "Add line" }).click();
    // Wait for the refreshed page, so Submit carries the order's new version.
    await expect(page.getByRole("listitem", { name: `Order line ${name}` })).toBeVisible();
    await page.getByRole("button", { name: "Submit order" }).click();
    await expect(page.getByLabel("Order status")).toContainText("Submitted");

    const receive = page.getByRole("form", { name: "Receive shipment" });

    await receive.getByLabel(`Received ${name} (PACK)`).fill("3");
    await receive.getByRole("button", { name: "Receive shipment" }).click();
    await expect(receive.getByRole("alert")).toContainText("Over-receiving isn't allowed");
    expect(await ledgerRowsFor(buns.id)).toEqual([]);
  });
});

test.describe("waste and authorization", () => {
  test("an inventory user records waste; stock falls and the ledger shows it", async ({ page }) => {
    const manager = await createRoleAccount("MANAGER");
    const name = `E2E Beef ${uniqueCode().slice(-6)}`;

    await createStockedItem(manager, { name, baseUnit: "OZ_WEIGHT", measurementType: "WEIGHT", opening: "64" });
    await signIn(page, manager);
    await page.goto("/inventory/movements");

    const waste = page.getByRole("region", { name: "Record waste" });

    await waste.locator('select[name="inventoryItemId"]').selectOption({ label: `${name} (64 OZ_WEIGHT on hand)` });
    await waste.getByLabel("Quantity").fill("1");
    await waste.locator('select[name="unitOfMeasureId"]').selectOption({ label: "LB" });
    await waste.locator('select[name="reasonCode"]').selectOption("SPOILAGE");
    await waste.getByRole("button", { name: "Record waste" }).click();
    await expect(waste.getByRole("status")).toContainText("Saved.");

    await page.goto("/inventory");
    await expect(stockRow(page, name)).toContainText("48 OZ_WEIGHT");

    await page.goto("/inventory/transactions?transactionType=WASTE");

    const row = page.getByRole("row", { name: `Transaction Waste ${name}` });

    await expect(row).toContainText("-1 LB");
    await expect(row).toContainText("-16");
    await expect(row).toContainText("SPOILAGE");
  });

  test("a Cook may record waste but not adjust; a Server sees no inventory at all", async ({ page, browser }) => {
    const manager = await createRoleAccount("MANAGER");
    const cook = await createRoleAccount("COOK");
    const server = await createRoleAccount("SERVER");
    const name = `E2E Lettuce ${uniqueCode().slice(-6)}`;
    const item = await createStockedItem(manager, { name, baseUnit: "EACH", opening: "10" });

    await signIn(page, cook);
    await page.goto("/inventory/movements");
    await expect(page.getByRole("region", { name: "Record waste" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Adjust stock" })).toHaveCount(0);

    const adjust = await page.request.post("/api/inventory/adjustments", {
      data: { inventoryItemId: item.id, quantity: "1", unitOfMeasureId: item.baseUnitId, direction: "INCREASE", reasonCode: "OTHER" },
    });

    expect(adjust.status()).toBe(403);

    const serverPage = await (await browser.newContext()).newPage();

    await signIn(serverPage, server);

    for (const path of ["/inventory", "/inventory/movements", "/purchasing/orders", "/purchasing/suppliers"]) {
      await serverPage.goto(path);
      await expect(serverPage).toHaveURL(/\/access-denied$/);
    }

    expect((await serverPage.request.get("/api/inventory/on-hand")).status()).toBe(403);
    expect(
      (
        await serverPage.request.post("/api/inventory/waste", {
          data: { inventoryItemId: item.id, quantity: "1", unitOfMeasureId: item.baseUnitId, reasonCode: "OTHER" },
        })
      ).status(),
    ).toBe(403);
    await serverPage.context().close();
  });

  test("an inventory viewer sees quantities but no costs", async ({ page }) => {
    const manager = await createRoleAccount("MANAGER");
    const viewer = await createPermissionAccount(["inventory.view"]);
    const name = `E2E Limes ${uniqueCode().slice(-6)}`;

    await createStockedItem(manager, { name, baseUnit: "EACH", opening: "8" });
    await signIn(page, viewer);
    await page.goto("/inventory");
    await expect(stockRow(page, name)).toContainText("8 EACH");
    await expect(page.getByRole("columnheader", { name: "Average cost" })).toHaveCount(0);
  });

  test("a signed-out request is refused", async ({ request }) => {
    expect((await request.get("/api/inventory/on-hand")).status()).toBe(401);
    expect((await request.post("/api/purchasing/orders", { data: {} })).status()).toBe(401);
  });
});

test.describe("inventory count", () => {
  test("start, count, submit and approve; the variance posts and stock reconciles", async ({ page }) => {
    const manager = await createRoleAccount("MANAGER");
    const name = `E2E Cheese ${uniqueCode().slice(-6)}`;

    await createStockedItem(manager, { name, baseUnit: "SLICE", opening: "10" });
    await signIn(page, manager);
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Inventory counts", exact: true }).click();

    const countName = `E2E count ${uniqueCode().slice(-6)}`;

    await page.getByRole("region", { name: "Start a count" }).getByLabel("Count name").fill(countName);
    await page.getByRole("button", { name: "Start count" }).click();
    await page.getByRole("link", { name: `Open ${countName}` }).click();
    await expect(page).toHaveURL(/\/inventory\/counts\/[0-9a-f-]{36}$/);

    // Every other line (other items stocked here) is counted at its expected quantity.
    const countId = page.url().split("/").pop()!;
    const detail = await (await page.request.get(`/api/inventory/counts/${countId}`)).json();

    for (const line of detail.lines as { id: string; itemName: string; expectedQuantity: string; version: number }[]) {
      if (line.itemName !== name) {
        const saved = await page.request.patch(`/api/inventory/counts/${countId}/lines/${line.id}`, {
          data: { countedQuantity: line.expectedQuantity, notes: null, expectedVersion: line.version },
        });

        expect(saved.ok()).toBe(true);
      }
    }

    await page.reload();

    const mine = page.getByRole("listitem", { name: `Count line ${name}` });

    await expect(mine).toContainText("Expected 10 SLICE");
    await mine.getByLabel(`Counted ${name} (SLICE)`).fill("8");
    await mine.getByRole("button", { name: `Save ${name}` }).click();
    await expect(mine).toContainText("counted 8 · variance -2");

    await page.goto("/inventory");
    await expect(stockRow(page, name)).toContainText("10 SLICE");

    await page.goto(`/inventory/counts/${countId}`);
    await page.getByRole("button", { name: "Submit count" }).click();
    await expect(page.getByLabel("Count status")).toContainText("Submitted");
    await page.getByRole("region", { name: "Approve count" }).getByRole("button", { name: "Approve count" }).click();
    await expect(page.getByLabel("Count status")).toContainText("Approved");

    await page.goto("/inventory");
    await expect(stockRow(page, name)).toContainText("8 SLICE");
    await page.goto("/inventory/transactions?transactionType=COUNT_DECREASE");
    await expect(page.getByRole("row", { name: `Transaction Count decrease ${name}` })).toContainText("-2");
  });
});

test.describe("recipe ingredients", () => {
  test("a recipe editor adds ingredients to a draft, publishes it, and no stock moves", async ({ page }) => {
    const manager = await createRoleAccount("MANAGER");
    const beefName = `E2E Patty beef ${uniqueCode().slice(-6)}`;
    const beef = await createStockedItem(manager, { name: beefName, baseUnit: "OZ_WEIGHT", measurementType: "WEIGHT" });
    const recipeName = `E2E Burger ${uniqueCode().slice(-6)}`;

    await signIn(page, manager);
    await page.goto("/recipes");

    const add = page.getByRole("region", { name: "Add a recipe" });

    await add.getByLabel("Code (capitals, digits, underscores)").fill(uniqueCode("_RCP"));
    await add.getByLabel("Name", { exact: true }).fill(recipeName);
    await add.getByRole("button", { name: "Add recipe" }).click();
    await page.getByRole("link", { name: `Open ${recipeName}` }).click();

    const draft = page.getByRole("region", { name: "New revision" });

    await draft.getByLabel("Yield quantity").fill("1");
    await draft.getByRole("button", { name: "Create draft revision" }).click();

    const revision = page.getByRole("listitem", { name: "Revision 1" });

    await expect(revision).toContainText("Draft");
    await revision.locator('select[name="inventoryItemId"]').selectOption({ label: `${beefName} (stocked in OZ_WEIGHT)` });
    await revision.getByLabel("Quantity", { exact: true }).fill("0.5");
    await revision.locator('select[name="unitOfMeasureId"]').last().selectOption({ label: "LB" });
    await revision.getByRole("button", { name: "Add ingredient" }).click();
    await expect(revision.getByRole("listitem", { name: `Ingredient ${beefName}` })).toContainText("0.5 LB");

    // An incompatible unit is refused.
    await revision.locator('select[name="inventoryItemId"]').selectOption({ label: `${beefName} (stocked in OZ_WEIGHT)` });
    await revision.getByLabel("Quantity", { exact: true }).last().fill("1");
    await revision.locator('select[name="unitOfMeasureId"]').last().selectOption({ label: "ML" });
    await revision.getByRole("button", { name: "Add ingredient" }).click();
    await expect(revision.getByRole("alert").last()).toContainText("can't be converted");

    await revision.getByRole("button", { name: "Publish revision" }).click();
    await expect(revision).toContainText("Published");
    await expect(revision.getByRole("listitem", { name: `Ingredient ${beefName}` })).toContainText("0.5 LB");
    await expect(revision.getByRole("button", { name: "Add ingredient" })).toHaveCount(0);
    await expect(revision.getByRole("button", { name: `Save ${beefName}` })).toHaveCount(0);

    expect(await ledgerRowsFor(beef.id)).toEqual([]);
  });
});
