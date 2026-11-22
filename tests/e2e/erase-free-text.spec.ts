import { expect, test, type Browser, type Page } from "@playwright/test";

import { createGuestsSetup, disableGuestsAccounts, type GuestsSetup } from "../helpers/e2e-guests";
import { eraseGuestProfile, shiftNoteNaming, takeoutNaming } from "../helpers/e2e-erase";
import type { OrdersAccount } from "../helpers/e2e-orders";
import { signInWithRetry } from "../helpers/e2e-ui";

// Phase 34 (policies 11–14): the Owner erases a guest named in a takeout check and a shift
// note, sees both under possible mentions, confirms, and only the guest's words are replaced.

test.use({ timezoneId: "America/Detroit" });

let setup: GuestsSetup;

async function signedIn(browser: Browser, account: OrdersAccount): Promise<Page> {
  const page = await (await browser.newContext({ timezoneId: "America/Detroit" })).newPage();

  await signInWithRetry(page, account);
  expect((await page.request.put("/api/session/location", { data: { locationId: setup.locationId } })).ok()).toBe(true);

  return page;
}

test.beforeAll(async () => {
  setup = await createGuestsSetup();
});

test.afterAll(async () => {
  await disableGuestsAccounts(setup);
});

test("erasing a guest redacts their name in a takeout check, its instruction and a shift note", async ({ browser }) => {
  test.setTimeout(150_000);

  const surname = `Wex${setup.suffix.replace(/[^a-z]/g, "")}ford`;
  const profileId = await eraseGuestProfile(setup, `Jo ${surname}`);
  const orderId = await takeoutNaming(setup, surname);

  await shiftNoteNaming(setup, surname);

  const owner = await signedIn(browser, setup.owner);

  await owner.goto(`/host/guests/${profileId}`);

  const erase = owner.getByRole("form", { name: "Erase guest details" });

  await expect(erase.getByTestId("guest-mentions-TAKEOUT_NAME")).toContainText(`J. ${surname}`);
  await expect(erase.getByTestId("guest-mentions-ORDER_ITEM_INSTRUCTION")).toContainText(`${surname} is allergic to sesame`);
  await expect(erase.getByTestId("guest-mentions-SHIFT_NOTE")).toContainText(`${surname} anniversary`);
  await erase.getByLabel("Reason").fill("Guest asked to be forgotten");
  await erase.getByRole("button", { name: "Erase personal data" }).click();
  await expect(owner.getByText("Erased.")).toBeVisible();

  await owner.goto(`/orders/${orderId}`);
  await expect(owner.getByText("[redacted] is allergic to sesame").first()).toBeVisible();
  await expect(owner.getByText(surname)).toHaveCount(0);
});
