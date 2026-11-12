import { randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import {
  CLOSEOUT_SCOPE,
  createRoleAccount,
  removeOrdersE2eData,
  sentOrderFor,
  createOrderMenu,
  type OrdersAccount,
} from "../helpers/e2e-orders";

// Phase 17: the Taxes admin page, and the permission boundaries of the new screens. Tax is
// left OFF at the main location: both workers share it, and turning tax on would refuse
// other specs' SENDs (TAX_NOT_CONFIGURED). Tax-on behaviour is covered by the integration
// tests (tests/integration/orders/tax.test.ts).

async function signIn(page: Page, account: OrdersAccount) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

test.afterAll(async () => {
  await removeOrdersE2eData(CLOSEOUT_SCOPE);
});

test.describe("checks and close-out", () => {
  test("an owner adds a tax category with a rate, and a menu item can be assigned to it", async ({ page }) => {
    const owner = await createRoleAccount("OWNER", CLOSEOUT_SCOPE);
    const code = `E2E_${randomUUID().slice(0, 6).toUpperCase().replace(/-/g, "")}`;

    await signIn(page, owner);
    await page.goto("/admin/taxes");
    await expect(page.getByRole("heading", { name: "Taxes", level: 1 })).toBeVisible();
    await expect(page.getByText("Tax is off. Nothing sent here is taxed.")).toBeVisible();

    const add = page.getByRole("region", { name: "Add a tax category" });

    await add.getByLabel("Code (letters, digits and _, no spaces; for example FOOD)").fill(code);
    await add.getByLabel("Name").fill(`E2E food ${code}`);
    await add.getByRole("button", { name: "Add category" }).click();

    const category = page.getByRole("region", { name: `Tax category ${code}` });

    await expect(category).toBeVisible();
    await expect(category).toContainText("Rate here now: none");
    await category.getByLabel("New rate (%)").fill("8.25");
    await category.getByRole("button", { name: "Set rate" }).click();
    await expect(category).toContainText("Rate here now: 8.2500%");
    await expect(category).toContainText("8.2500%, added on top of menu prices");
  });

  test("a server can't reach Taxes, refunds or drawer operations, on screen or by API", async ({ page }) => {
    const manager = await createRoleAccount("MANAGER", CLOSEOUT_SCOPE);
    const server = await createRoleAccount("SERVER", CLOSEOUT_SCOPE);
    const menu = await createOrderMenu(manager);
    const { orderId } = await sentOrderFor(manager, [menu.soda.id]);

    await signIn(page, server);
    await page.goto("/admin/taxes");
    await expect(page).toHaveURL(/\/access-denied/);

    // Servers see the drawers (to choose one for cash) but can't open, count or set them up.
    await page.goto("/cash-drawers");
    await expect(page.getByRole("heading", { name: "Cash drawers", level: 1 })).toBeVisible();
    await expect(page.getByRole("region", { name: "Add a drawer" })).toHaveCount(0);

    expect((await page.request.post("/api/tax/categories", { data: { code: "NOPE", name: "Nope" } })).status()).toBe(403);
    expect((await page.request.post("/api/drawers", { data: { code: "NOPE", name: "Nope" } })).status()).toBe(403);
    expect(
      (
        await page.request.post(`/api/orders/${orderId}/refunds`, {
          data: { idempotencyKey: `e2e-${randomUUID()}`, tenderType: "CASH", amount: "1.00", reason: "x" },
        })
      ).status(),
    ).toBe(403);
  });
});
