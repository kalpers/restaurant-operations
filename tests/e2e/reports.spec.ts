import { readFile } from "node:fs/promises";

import { expect, test, type Page } from "@playwright/test";

import { findMainLocationId } from "../helpers/e2e-accounts";
import {
  createOrderMenu,
  createRoleAccount,
  removeOrdersE2eData,
  REPORTS_SCOPE,
  sentOrderFor,
  settleInCashFor,
  type OrdersAccount,
} from "../helpers/e2e-orders";

// Reporting is read-only. Other specs sell at MAIN on parallel workers, so these tests
// assert this spec's own uniquely coded menu item, never location-wide totals.

const account = (roleCode: string) => createRoleAccount(roleCode, REPORTS_SCOPE);

async function signIn(page: Page, user: OrdersAccount) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

/** Two sodas sold and settled on a closed takeout order, plus one left open. */
async function soldSodas() {
  const manager = await account("MANAGER");
  const menu = await createOrderMenu(manager);
  const closed = await sentOrderFor(manager, [menu.soda.id, menu.soda.id]);

  await settleInCashFor(manager, closed.orderId);
  await sentOrderFor(manager, [menu.soda.id]);

  return { manager, soda: menu.soda };
}

test.afterAll(async () => {
  await removeOrdersE2eData(REPORTS_SCOPE);
});

test.describe("reports", () => {
  test("a manager sees the overview and menu performance, but not labor or export", async ({ page }) => {
    const { manager, soda } = await soldSodas();

    await signIn(page, manager);

    const overview = page.getByRole("region", { name: "Operational overview" });

    await expect(overview.getByRole("definition").first()).toBeVisible();
    await expect(page.getByLabel("Sales", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Labor", { exact: true })).toHaveCount(0);

    await page.getByRole("navigation").getByRole("link", { name: "Reports" }).first().click();
    await expect(page).toHaveURL(/\/reports$/);
    await expect(page.getByRole("link", { name: /^Labor/ })).toHaveCount(0);

    await page.getByRole("link", { name: /^Menu performance/ }).click();

    const items = page.getByRole("table", { name: "Menu items" });
    const row = items.getByRole("row").filter({ hasText: soda.code });

    // `next dev` compiles the report route on its first request.
    await expect(items).toBeVisible({ timeout: 20_000 });

    // Only the closed order counts: two sodas at 2.50.
    await expect(row).toContainText("2");
    await expect(row).toContainText("$5.00");
    await expect(page.getByText("Sales are CLOSED orders, before tax")).toBeVisible();
    // Export needs reports.export, which managers don't hold.
    await expect(page.getByRole("link", { name: /Export/ })).toHaveCount(0);

    // Hidden UI is not authorization: the labor page and API are refused too.
    await page.goto("/reports/labor");
    await expect(page).toHaveURL(/\/access-denied$/);

    const locationId = await findMainLocationId();
    const query = `locationId=${locationId}&from=2030-01-01&to=2030-01-01`;

    expect((await page.request.get(`/api/reports/labor?${query}`)).status()).toBe(403);
    expect((await page.request.get(`/api/reports/sales/export?${query}`)).status()).toBe(403);
    expect((await page.request.get(`/api/reports/sales?${query}`)).status()).toBe(200);
  });

  test("an owner exports the menu report as CSV", async ({ page }) => {
    const { soda } = await soldSodas();
    const owner = await account("OWNER");

    await signIn(page, owner);
    await page.goto("/reports/menu");
    await expect(page.getByRole("table", { name: "Menu items" })).toBeVisible({ timeout: 20_000 });

    const download = page.waitForEvent("download");

    await page.getByRole("link", { name: "Export Menu items as CSV" }).click();

    const file = await download;
    const csv = await readFile((await file.path())!, "utf8");

    expect(file.suggestedFilename()).toMatch(/^menu_items_MAIN_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv$/);
    expect(csv).toContain("Report,Menu performance\r\n");
    expect(csv).toContain("Item code,Item,Quantity sold,Gross sales,Item discounts");
    expect(csv).toContain(`${soda.code},${soda.name},2,5.00,0.00`);
  });

  test("a server has no reports, in the menu or by direct request", async ({ page, playwright }) => {
    const server = await account("SERVER");
    const locationId = await findMainLocationId();
    const query = `locationId=${locationId}&from=2030-01-01&to=2030-01-01`;

    await signIn(page, server);
    await expect(page.getByRole("navigation").getByRole("link", { name: "Reports" })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Operational overview" })).toHaveCount(0);

    await page.goto("/reports");
    await expect(page).toHaveURL(/\/access-denied$/);
    expect((await page.request.get(`/api/reports/sales?${query}`)).status()).toBe(403);
    expect((await page.request.get(`/api/reports/dashboard?locationId=${locationId}`)).status()).toBe(403);

    const anonymous = await playwright.request.newContext({ baseURL: test.info().project.use.baseURL });

    expect((await anonymous.get(`/api/reports/sales?${query}`)).status()).toBe(401);
    expect((await anonymous.get(`/api/reports/sales/export?${query}`)).status()).toBe(401);
    await anonymous.dispose();
  });
});
