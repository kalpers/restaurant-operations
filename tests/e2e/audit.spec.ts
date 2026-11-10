import { expect, test, type Page } from "@playwright/test";

import { findMainLocationId } from "../helpers/e2e-accounts";
import {
  AUDIT_SCOPE,
  createOrderMenu,
  createRoleAccount,
  removeOrdersE2eData,
  sentOrderFor,
  settleInCashFor,
  type OrdersAccount,
} from "../helpers/e2e-orders";

// The audit trail is append-only and shared by parallel workers, so these tests look for
// rows made by this spec's own accounts, never for counts.

const account = (roleCode: string) => createRoleAccount(roleCode, AUDIT_SCOPE);

async function signIn(page: Page, user: OrdersAccount) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

test.afterAll(async () => {
  await removeOrdersE2eData(AUDIT_SCOPE);
});

test.describe("audit trail", () => {
  test("an owner finds a manager's settlement and sign-in on the audit page", async ({ page }) => {
    const manager = await account("MANAGER");
    const menu = await createOrderMenu(manager);
    const order = await sentOrderFor(manager, [menu.soda.id]);

    await settleInCashFor(manager, order.orderId);

    const owner = await account("OWNER");

    // A wrong password first: its audit event is written after the response.
    await page.goto("/login");
    await page.getByLabel("Email").fill(owner.email);
    await page.getByLabel("Password").fill("not-the-password-123");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("Invalid email or password")).toBeVisible();

    await signIn(page, owner);
    await page.getByRole("navigation").getByRole("link", { name: "Audit" }).first().click();
    await expect(page).toHaveURL(/\/audit$/);
    await expect(page.getByRole("heading", { name: "Audit trail" })).toBeVisible({ timeout: 20_000 });

    await page.getByLabel("Action").selectOption("settlements.completed");
    await page.getByRole("button", { name: "Filter" }).click();

    const completed = page.getByRole("row", { name: "Audit settlements.completed" }).filter({ hasText: manager.email });

    await expect(completed.first()).toBeVisible();
    await completed.first().getByText("Show").click();
    await expect(completed.first()).toContainText('"status": "COMPLETED"');

    // The owner's own sign-in is an organization-level event.
    await page.getByLabel("Action").selectOption("auth.signed-in");
    await page.getByRole("button", { name: "Filter" }).click();
    await expect(page.getByRole("row", { name: "Audit auth.signed-in" }).filter({ hasText: owner.email })).toHaveCount(1);

    await page.getByLabel("Action").selectOption("auth.sign-in-failed");
    await page.getByRole("button", { name: "Filter" }).click();

    const failed = page.getByRole("row", { name: "Audit auth.sign-in-failed" }).filter({ hasText: owner.email });

    await expect(failed).toHaveCount(1);
    await failed.getByText("Show").click();
    await expect(failed).toContainText('"reason": "BAD_PASSWORD"');
  });

  test("a manager without audit.view has no audit menu, page or API", async ({ page }) => {
    const manager = await account("MANAGER");
    const locationId = await findMainLocationId();

    await signIn(page, manager);
    await expect(page.getByRole("navigation").getByRole("link", { name: "Audit" })).toHaveCount(0);

    await page.goto("/audit");
    await expect(page).toHaveURL(/\/access-denied$/);
    expect((await page.request.get(`/api/audit?locationId=${locationId}&from=2030-01-01&to=2030-01-01`)).status()).toBe(403);
  });
});
