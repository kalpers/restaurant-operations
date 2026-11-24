import { expect, test, type Browser, type Page } from "@playwright/test";

import { createBriefingsSetup, disableBriefingsAccounts, type BriefingsSetup } from "../helpers/e2e-briefings";
import { createReceivedDelivery } from "../helpers/e2e-invoices";
import type { E2eScope, OrdersAccount } from "../helpers/e2e-orders";
import { expandNavGroups, signInWithRetry } from "../helpers/e2e-ui";

// Phase 36 part 4: a manager enters a supplier invoice against a delivery, with a price above
// the receipt's cost and a freight line; the manager can't approve it; the owner approves it
// with a reason, and the line shows its stored variance.

test.describe.configure({ mode: "serial" });
test.use({ timezoneId: "America/Detroit" });

const SCOPE: E2eScope = { emailDomain: "invoices-e2e.example.test", rolePrefix: "INVOICES_E2E_", tablePrefix: "INVC-" };

let setup: BriefingsSetup;
let delivery: Awaited<ReturnType<typeof createReceivedDelivery>>;

async function signedIn(browser: Browser, account: OrdersAccount): Promise<Page> {
  const page = await (await browser.newContext({ timezoneId: "America/Detroit" })).newPage();

  await signInWithRetry(page, account);
  expect((await page.request.put("/api/session/location", { data: { locationId: setup.locationId } })).ok()).toBe(true);

  return page;
}

test.beforeAll(async () => {
  setup = await createBriefingsSetup(SCOPE);
  delivery = await createReceivedDelivery(setup);
});

test.afterAll(async () => {
  await disableBriefingsAccounts(SCOPE);
});

test("an invoice is matched against its delivery and approved with a reason", async ({ browser }) => {
  test.setTimeout(120_000);

  const manager = await signedIn(browser, setup.manager);

  // Supplier invoices are in the Back of house group.
  await manager.goto("/dashboard");
  await expandNavGroups(manager);
  await manager.getByRole("link", { name: "Supplier invoices" }).click();
  await manager.getByRole("link", { name: "Enter an invoice" }).click();

  const form = manager.getByRole("form", { name: "Enter an invoice" });

  await form.getByRole("combobox", { name: "Supplier", exact: true }).selectOption({ label: delivery.supplierName });
  await form.getByLabel("Supplier's invoice number").fill(`C-${setup.suffix}`);
  await form.getByLabel("Invoice date").fill("2026-11-20");
  await form.getByLabel("Invoice total").fill("265.00");
  await form.getByLabel(`Invoice ${delivery.itemName}`).check();
  await form.getByLabel(`Invoiced unit price of ${delivery.itemName}`).fill("25.50");
  await form.getByRole("button", { name: "Add freight, tax, charge or credit" }).click();
  await form.getByLabel("Line 1 description").fill("Delivery");
  await form.getByLabel("Line 1 amount").fill("10.00");
  await expect(form.getByTestId("invoice-running-total")).toContainText("265.00");
  await form.getByRole("button", { name: "Enter invoice" }).click();

  await expect(manager.getByRole("heading", { name: new RegExp(`INV-\\d{6} · ${delivery.supplierName}`) })).toBeVisible();
  // 25.50 against 24.00 is over the 2% (0.50 per case) tolerance.
  await expect(manager.getByTestId("invoice-line").filter({ hasText: delivery.itemName }).getByText("Price 1.5000 (6.25%)")).toBeVisible();
  await expect(manager.getByRole("button", { name: "Approve" })).toHaveCount(0);

  const invoiceUrl = manager.url();
  const owner = await signedIn(browser, setup.owner);

  await owner.goto(invoiceUrl);
  await owner.getByRole("button", { name: "Approve" }).click();

  const dialog = owner.getByRole("dialog", { name: "Approve this invoice?" });

  await expect(dialog.getByRole("button", { name: "Approve invoice" })).toBeDisabled();
  await dialog.getByLabel("Why approve despite the variances?").fill("Market price rose; agreed by phone");
  await dialog.getByRole("button", { name: "Approve invoice" }).click();

  await expect(owner.getByText("Approved", { exact: true })).toBeVisible();
  await expect(owner.getByText("Approved despite variances: Market price rose; agreed by phone")).toBeVisible();
  await expect(owner.getByTestId("invoice-line").filter({ hasText: delivery.itemName }).getByText("Price 1.5000 (6.25%)")).toBeVisible();
});
