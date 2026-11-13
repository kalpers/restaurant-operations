import { expect, test, type Locator } from "@playwright/test";

import {
  createOwner,
  expireLotTomorrow,
  mainLocationId,
  openSecondLocation,
  shortCode,
  signedIn,
  stockedEverywhere,
} from "../helpers/e2e-locations";
import type { OrdersAccount } from "../helpers/e2e-orders";

// Phase 23: a manager turns on lot tracking for cheese, records found stock with a use-by
// date, sends part of it to the other location, which receives it one short. The lot arrives
// with the same use-by date, the first to expire went first, and the lot trace shows the trip.

test.describe.configure({ mode: "serial" });

let owner: OrdersAccount;
let main: string;
let other: string;
let cheese: { id: string; name: string };
const otherName = `Harbor E2E ${shortCode("")}`;
const useBy = "2030-01-15";

test.beforeAll(async () => {
  owner = await createOwner();
  main = await mainLocationId();
  other = await openSecondLocation(owner, otherName);
  const item = await stockedEverywhere(owner, `E2E Cheddar ${shortCode("")}`, [main, other]);
  cheese = { id: item.id, name: item.name };
});

test("lot tracking is turned on and found stock becomes a dated lot", async ({ browser }) => {
  const page = await signedIn(browser, owner, main);

  await page.goto(`/inventory/items/${cheese.id}`);
  await page.getByRole("button", { name: "Turn lot tracking on" }).click();
  await expect(page.getByRole("button", { name: "Turn lot tracking off" })).toBeVisible({ timeout: 20_000 });

  await page.goto("/inventory/movements");
  const adjust = page.getByRole("region", { name: "Adjust stock" });
  await adjust.getByRole("combobox", { name: /^Item/ }).selectOption({ index: await optionIndex(adjust.getByRole("combobox", { name: /^Item/ }), cheese.name) });
  await adjust.getByLabel("Quantity", { exact: true }).fill("5");
  await adjust.getByRole("combobox", { name: /^Unit/ }).selectOption({ label: "EACH" });
  await adjust.getByRole("combobox", { name: /^Direction/ }).selectOption({ label: "Increase" });
  await adjust.getByRole("combobox", { name: /^Reason/ }).selectOption({ label: "Found stock" });
  await adjust.getByLabel("Use by date (lot tracking, increases only)").fill(useBy);
  await adjust.getByRole("button", { name: "Record adjustment" }).click();
  await expect(page.getByText("Saved.")).toBeVisible({ timeout: 20_000 });

  await page.goto("/inventory/lots");
  const lot = page.getByTestId("lot-row").filter({ hasText: cheese.name });
  await expect(lot).toContainText(`use by ${useBy}`, { timeout: 20_000 });
  await expect(lot).toContainText("5 EACH left");
});

test("a transfer is sent, arrives one short, and its lot keeps the use-by date", async ({ browser }) => {
  const sender = await signedIn(browser, owner, main);

  await sender.goto("/inventory/transfers");
  const form = sender.getByRole("form", { name: "New transfer" });
  await form.getByRole("combobox", { name: /^To/ }).selectOption({ label: otherName });
  await form.getByRole("combobox", { name: /^Item/ }).selectOption({ index: await optionIndex(form.getByRole("combobox", { name: /^Item/ }), cheese.name) });
  await form.getByLabel("Quantity", { exact: true }).fill("4");
  await form.getByRole("combobox", { name: /^Unit/ }).selectOption({ label: "EACH" });
  await form.getByRole("button", { name: "Save draft" }).click();
  await expect(sender.getByText("Draft saved.", { exact: false })).toBeVisible({ timeout: 20_000 });
  const draft = sender.getByTestId("draft-transfer").filter({ hasText: otherName });
  await draft.getByRole("button", { name: "Send" }).click();
  await expect(sender.getByRole("region", { name: "Sent, not yet received" })).toContainText(otherName, { timeout: 20_000 });

  const receiver = await signedIn(browser, owner, other);
  await receiver.goto("/inventory/transfers");
  const incoming = receiver.getByTestId("incoming-transfer").first();
  await incoming.getByLabel(new RegExp(`${cheese.name}: arrived`)).fill("3");
  await incoming.getByRole("button", { name: "Receive" }).click();
  await expect(receiver.getByRole("region", { name: "Recent transfers" })).toContainText("Received", { timeout: 20_000 });

  await receiver.goto("/inventory/lots");
  const lot = receiver.getByTestId("lot-row").filter({ hasText: cheese.name });
  await expect(lot).toContainText(`use by ${useBy}`);
  await expect(lot).toContainText("3 EACH left");
  await expect(lot).toContainText("Transferred in");

  await lot.getByRole("link", { name: "Trace" }).click();
  await expect(receiver.getByRole("heading", { name: /Lot trace/ })).toBeVisible({ timeout: 20_000 });
  await expect(receiver.getByText("Came from")).toBeVisible();
});

async function optionIndex(select: Locator, text: string): Promise<number> {
  const labels = await select.locator("option").allTextContents();
  const index = labels.findIndex((label) => label.includes(text));

  expect(index).toBeGreaterThan(-1);

  return index;
}

// Phase 24 (Phase 23 gap): the expiry warning reaches the bell.
test("a lot about to expire raises a bell notice that links to the lots page", async ({ browser }) => {
  expect(await expireLotTomorrow(owner, other, cheese.id)).toBeGreaterThan(0);

  const page = await signedIn(browser, owner, other);

  await page.goto("/inventory/lots");
  await expect(page.getByTestId("notification-count")).toBeVisible();
  await page.getByTestId("notification-bell").click();
  await expect(page.getByText(`Expiring soon: ${cheese.name}`)).toBeVisible();
  await page.getByRole("link", { name: "See lots" }).first().click();
  await expect(page).toHaveURL(/\/inventory\/lots$/);
});
