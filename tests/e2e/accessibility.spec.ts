import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import {
  createOrderMenu,
  createRoleAccount,
  removeOrdersE2eData,
  sentOrderFor,
  UI_SCOPE,
  type OrdersAccount,
} from "../helpers/e2e-orders";

// Phase 15: an automated WCAG 2.1 A/AA check of the main screens. It fails on serious or
// critical violations; minor and moderate findings are printed for review.

async function signIn(page: Page, account: OrdersAccount) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

async function expectAccessible(page: Page, name: string) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const blocking = results.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical");

  for (const violation of results.violations.filter((entry) => !blocking.includes(entry))) {
    console.log(`[axe ${name}] ${violation.impact}: ${violation.id} (${violation.nodes.length})`);
  }

  expect(
    blocking.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      targets: violation.nodes.slice(0, 3).map((node) => node.target.join(" ")),
    })),
    `${name} has serious or critical accessibility violations`,
  ).toEqual([]);
}

test.afterAll(async () => {
  await removeOrdersE2eData(UI_SCOPE);
});

test.describe("accessibility", () => {
  test("the login page", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    await expectAccessible(page, "Login");
  });

  test("the main operational screens", async ({ page }) => {
    test.setTimeout(120_000);

    const owner = await createRoleAccount("OWNER", UI_SCOPE);
    const menu = await createOrderMenu(owner);
    const { orderId } = await sentOrderFor(owner, [menu.soda.id]);

    await signIn(page, owner);
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Operational overview" }).getByRole("definition").first()).toBeVisible({
      timeout: 20_000,
    });
    await expectAccessible(page, "Dashboard");

    const screens: { path: string; ready: (page: Page) => Promise<void>; name: string }[] = [
      { name: "Floor", path: "/restaurant/floor", ready: (p) => expect(p.getByRole("heading", { name: "Floor", exact: true })).toBeVisible() },
      { name: "Order", path: `/orders/${orderId}`, ready: (p) => expect(p.getByRole("heading", { name: /Order #\d+/ })).toBeVisible() },
      { name: "Kitchen", path: "/kitchen", ready: (p) => expect(p.getByRole("heading", { name: "Kitchen", exact: true })).toBeVisible() },
      { name: "Settlement", path: `/orders/${orderId}/settlement`, ready: (p) => expect(p.getByRole("heading", { name: /Settle order/ })).toBeVisible() },
      { name: "Timeline", path: "/scheduling/timeline", ready: (p) => expect(p.locator('[data-ready="true"]').first()).toBeVisible({ timeout: 20_000 }) },
      { name: "Audit", path: "/audit", ready: (p) => expect(p.getByRole("heading", { name: "Audit trail" })).toBeVisible({ timeout: 20_000 }) },
      { name: "Reservations", path: "/host/reservations", ready: (p) => expect(p.getByRole("heading", { level: 1 })).toBeVisible() },
      { name: "Employees", path: "/employees", ready: (p) => expect(p.getByRole("heading", { level: 1 })).toBeVisible() },
    ];

    for (const screen of screens) {
      await page.goto(screen.path);
      await screen.ready(page);
      await expectAccessible(page, screen.name);
    }
  });
});
