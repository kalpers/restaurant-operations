import { expect, test } from "@playwright/test";

import { createMainManager, createOwner, locationIdByName, mainLocationId, shortCode, signedIn } from "../helpers/e2e-locations";
import type { OrdersAccount } from "../helpers/e2e-orders";

// Phase 23: an Owner opens a location copied from MAIN, switches to it, is stopped when a tab
// left at the other location tries to save, compares sales across locations, and closes it.

test.describe.configure({ mode: "serial" });

let owner: OrdersAccount;
const name = `Uptown E2E ${shortCode("")}`;

test.beforeAll(async () => {
  owner = await createOwner();
});

test("an Owner opens a new location copied from MAIN and switches to it", async ({ browser }) => {
  const page = await signedIn(browser, owner);

  // One location: its name is shown, with no picker.
  await expect(page.getByTestId("current-location")).toHaveText("Main Restaurant");

  await page.goto("/admin/locations");
  const form = page.getByRole("form", { name: "New location" });
  await form.getByLabel("Name", { exact: true }).fill(name);
  await form.getByLabel("Code", { exact: true }).fill(shortCode("UP"));
  await form.getByLabel("Copy setup from").selectOption({ label: "Main Restaurant" });
  await expect(form.getByLabel("Menu prices set for that location")).toBeChecked();
  await form.getByRole("button", { name: "Open location" }).click();
  await expect(page.getByText("Location opened.")).toBeVisible({ timeout: 20_000 });

  const switcher = page.getByRole("combobox", { name: /^Location/ });
  await switcher.selectOption({ label: name });
  await expect(switcher.locator("option:checked")).toHaveText(name);
});

test("a tab left at the other location is refused when it saves", async ({ browser }) => {
  const main = await mainLocationId();
  const uptown = await locationIdByName(name);
  const first = await signedIn(browser, owner, main);

  // This tab shows MAIN.
  await first.goto("/admin/users");
  await first.getByLabel("Email", { exact: true }).fill(`stale-${shortCode("")}@locations-e2e.example.test`.toLowerCase());
  await first.getByLabel(/Initial password/).fill("a-long-enough-password-123");

  // Another tab of the same browser switches to the new location.
  const second = await first.context().newPage();
  expect((await second.request.put("/api/session/location", { data: { locationId: uptown } })).ok()).toBe(true);

  await first.getByRole("button", { name: "Create user" }).click();
  await expect(first.getByRole("alert").filter({ hasText: "switched location in another tab" })).toBeVisible();
  await expect(first.getByRole("button", { name: "Reload" })).toBeVisible();
});

test("sales can be compared across both locations", async ({ browser }) => {
  const page = await signedIn(browser, owner);

  await page.goto("/reports/sales?locationId=ALL");
  await expect(page.getByRole("heading", { name: "By location" })).toBeVisible({ timeout: 20_000 });
  const table = page.getByRole("table").first();
  await expect(table.getByText("Main Restaurant")).toBeVisible();
  await expect(table.getByText(name)).toBeVisible();
  await expect(table.getByText("All locations")).toBeVisible();
});

// Phase 24 (Phase 23 gap): access to a second location for someone who already works here.
test("the Owner adds an existing MAIN manager to the new location", async ({ browser }) => {
  const manager = await createMainManager();
  const page = await signedIn(browser, owner, await locationIdByName(name));

  await page.goto("/admin/users");
  const section = page.locator("section", { has: page.getByRole("heading", { name: "Add an existing person" }) });

  await section.getByLabel("Find by email").fill(manager.email.slice(0, 18));
  await section.getByRole("combobox", { name: /^Person/ }).selectOption({ label: manager.email });
  await section.getByRole("combobox", { name: /^Role at this location/ }).selectOption({ label: "Manager" });
  await section.getByRole("button", { name: "Add to this location" }).click();
  await expect(page.getByText("Added to this location.")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("li").filter({ hasText: manager.email }).first()).toContainText("Manager");

  // The manager can now switch to it.
  const managerPage = await signedIn(browser, manager);

  await expect(managerPage.getByRole("combobox", { name: /^Location/ }).locator("option", { hasText: name })).toHaveCount(1);
});

test("the Owner closes the new location and it leaves the switcher", async ({ browser }) => {
  const page = await signedIn(browser, owner);

  await page.goto("/admin/locations");
  const row = page.getByTestId("location-lifecycle-row").filter({ hasText: name });
  await row.getByRole("button", { name: "Close location" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Close location" }).click();
  await expect(row.getByText("Closed")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("current-location")).toHaveText("Main Restaurant");
});
