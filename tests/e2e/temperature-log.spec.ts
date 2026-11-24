import { expect, test, type Browser, type Page } from "@playwright/test";

import { createBriefingsSetup, disableBriefingsAccounts, type BriefingsSetup } from "../helpers/e2e-briefings";
import type { E2eScope, OrdersAccount } from "../helpers/e2e-orders";
import { expandNavGroups, signInWithRetry } from "../helpers/e2e-ui";

// Phase 36 part 2: a manager sets up a walk-in cooler; a cook records an in-range and an
// out-of-range reading (which needs a corrective action); the manager gets a bell notice and
// sees both in the log, then a correcting reading marks a mistake without changing it.

test.describe.configure({ mode: "serial" });
test.use({ timezoneId: "America/Detroit" });

const SCOPE: E2eScope = { emailDomain: "temperature-e2e.example.test", rolePrefix: "TEMPERATURE_E2E_", tablePrefix: "TMP-" };

let setup: BriefingsSetup;

async function signedIn(browser: Browser, account: OrdersAccount): Promise<Page> {
  const page = await (await browser.newContext({ timezoneId: "America/Detroit" })).newPage();

  await signInWithRetry(page, account);
  expect((await page.request.put("/api/session/location", { data: { locationId: setup.locationId } })).ok()).toBe(true);

  return page;
}

test.beforeAll(async () => {
  setup = await createBriefingsSetup(SCOPE);
});

test.afterAll(async () => {
  await disableBriefingsAccounts(SCOPE);
});

test("a cook logs temperatures, an out-of-range one reaches the manager", async ({ browser }) => {
  test.setTimeout(120_000);

  const cooler = `Walk-in ${setup.suffix}`;
  const manager = await signedIn(browser, setup.manager);

  // The Temperature log is in the Back of house group.
  await manager.goto("/dashboard");
  await expandNavGroups(manager);
  await manager.getByRole("link", { name: "Temperature log" }).click();
  await manager.getByRole("link", { name: "Set up check points" }).click();

  const form = manager.getByRole("form", { name: "New check point" });

  await form.getByLabel("Name").fill(cooler);
  await form.getByLabel("Lowest safe (°F)").fill("33");
  await form.getByLabel("Highest safe (°F)").fill("41");
  await form.getByLabel("Check every (minutes)").fill("240");
  await form.getByRole("button", { name: "Add check point" }).click();
  await expect(manager.getByTestId("temperature-point").filter({ hasText: cooler })).toContainText("33.0–41.0 °F");

  // The cook records an in-range reading, then an out-of-range one with a corrective action.
  const cook = await signedIn(browser, setup.cook);

  await cook.goto("/temperature-log");

  const record = cook.getByRole("form", { name: "Record a reading" });

  await record.getByLabel("Check point").selectOption({ label: cooler });
  await record.getByLabel("Temperature (°F)").fill("38");
  await record.getByRole("button", { name: "Record reading" }).click();
  await expect(cook.getByTestId("temperature-reading").filter({ hasText: "38.0 °F" })).toBeVisible();

  await record.getByLabel("Temperature (°F)").fill("46");
  await expect(record.getByText("Out of range. Say what was done about it.")).toBeVisible();
  await record.getByLabel("Corrective action (required)").fill(`Door left open; stock moved (${setup.suffix})`);
  await record.getByRole("button", { name: "Record reading" }).click();

  const outOfRange = cook.getByTestId("temperature-reading").filter({ hasText: "46.0 °F" });

  await expect(outOfRange.getByText("Out of range")).toBeVisible();

  // A mistaken reading is corrected by a new one; the original stays, marked.
  const first = cook.getByTestId("temperature-reading").filter({ hasText: "38.0 °F" });

  await first.getByRole("button", { name: "Correct" }).click();
  await expect(record.getByText(/Corrects the 38\.0 °F reading/)).toBeVisible();
  await record.getByLabel("Temperature (°F)").fill("37");
  await record.getByRole("button", { name: "Record reading" }).click();
  await expect(first.getByText("Corrected")).toBeVisible();
  await expect(cook.getByTestId("temperature-reading").filter({ hasText: "37.0 °F" }).getByText("Correction")).toBeVisible();

  // The manager has a bell notice that opens the log.
  await manager.goto("/temperature-log");
  await expect(manager.getByTestId("notification-count")).toBeVisible();
  await manager.getByTestId("notification-bell").click();
  await expect(manager.getByText(`${cooler} is out of range`)).toBeVisible();
  await manager.getByRole("link", { name: "Open the temperature log" }).first().click();
  await expect(manager).toHaveURL(/\/temperature-log$/);
  await expect(manager.getByTestId("temperature-reading").filter({ hasText: `Door left open; stock moved (${setup.suffix})` })).toBeVisible();
});
