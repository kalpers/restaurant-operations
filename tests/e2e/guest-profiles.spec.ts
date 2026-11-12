import { expect, test, type Browser, type Page } from "@playwright/test";

import {
  createGuestsSetup,
  disableGuestsAccounts,
  partyNamed,
  profileFor,
  seatWithDraft,
  type GuestsSetup,
} from "../helpers/e2e-guests";
import type { OrdersAccount } from "../helpers/e2e-orders";

// Phase 21: guest profiles and allergies at the host stand, the allergy warning and
// confirmation at SEND, the kitchen's allergy alert, allergen setup, merge and erase.

test.describe.configure({ mode: "serial" });
test.use({ timezoneId: "America/Detroit" });

let setup: GuestsSetup;

async function signedIn(browser: Browser, account: OrdersAccount): Promise<Page> {
  const page = await (await browser.newContext({ timezoneId: "America/Detroit" })).newPage();

  await page.goto("/login");
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  expect((await page.request.put("/api/session/location", { data: { locationId: setup.locationId } })).ok()).toBe(true);

  return page;
}

test.beforeAll(async () => {
  setup = await createGuestsSetup();
});

test.afterAll(async () => {
  await disableGuestsAccounts();
});

test("a host adds a walk-in with a new profile and a severe peanut allergy; the server must confirm before sending", async ({
  browser,
}) => {
  test.setTimeout(120_000);

  const guestName = `Ana E2E ${setup.suffix}`;
  const host = await signedIn(browser, setup.host);

  await host.goto("/host/waitlist");

  const addForm = host.getByRole("form", { name: "Add walk-in" });

  await addForm.getByLabel("Find a guest profile").fill(guestName);
  await addForm.getByRole("button", { name: `New profile for "${guestName}"` }).click();
  await expect(addForm).toContainText(`Guest profile: ${guestName}`);
  await addForm.getByRole("button", { name: "Add to waitlist" }).click();

  const card = host.getByRole("listitem", { name: `Waitlist entry for ${guestName}` });

  await card.getByRole("button", { name: "Guest & allergies" }).click();

  const allergyForm = card.getByRole("form", { name: `Add allergy for ${guestName}` });

  await allergyForm.getByLabel("Allergen").selectOption({ label: "Peanuts" });
  await allergyForm.getByLabel("Severity").selectOption("SEVERE");
  await allergyForm.getByLabel("Also save to the profile").check();
  await allergyForm.getByRole("button", { name: "Record allergy" }).click();
  await expect(card).toContainText("Allergy: Peanuts");

  // Seated, with the satay drafted on the check.
  const party = await partyNamed(setup, guestName);
  const orderId = await seatWithDraft(setup, party.id, setup.satay.id);
  const server = await signedIn(browser, setup.server);

  await server.goto(`/orders/${orderId}`);

  const allergies = server.getByRole("region", { name: "Allergies" });

  await expect(allergies).toContainText("Peanuts · severe");
  await expect(server.getByRole("listitem", { name: `Unsent ${setup.satay.name}` })).toContainText(
    "ALLERGY: Peanuts (severe). Check with the guest before sending.",
  );

  await server.getByRole("button", { name: "Send 1 item" }).click();

  const dialog = server.getByRole("dialog", { name: "Allergy check before sending" });

  await expect(dialog).toContainText(`${setup.satay.name}: ALLERGY: Peanuts (severe)`);
  await dialog.getByRole("button", { name: "Guest confirmed, send" }).click();
  await expect(server.getByRole("listitem", { name: `Sent ${setup.satay.name}` })).toContainText("Sent after allergy check");

  // The kitchen sees the alert on the ticket.
  const cook = await signedIn(browser, setup.cook);

  await cook.goto("/kitchen");
  await expect(cook.getByTestId("ticket-allergy-alert").filter({ hasText: "ALLERGY: Peanuts (severe)" }).first()).toBeVisible();

  // The profile keeps the allergy and shows the visit.
  await host.goto(`/host/guests?q=${encodeURIComponent(guestName)}`);
  await host.getByRole("link", { name: guestName }).click();
  await expect(host.getByRole("region", { name: "Visits" })).toContainText(setup.satay.name);
});

test("a manager sees an unreviewed item as incomplete, and declares its allergens", async ({ browser }) => {
  const manager = await signedIn(browser, setup.manager);

  await manager.goto(`/menu/items/${setup.bread.id}`);

  const section = manager.getByRole("region", { name: "Allergens" });

  await expect(section).toContainText("Allergens incomplete");
  await section.getByLabel("Wheat").selectOption("CONTAINS");
  await section.getByRole("button", { name: "Save and mark reviewed" }).click();
  await expect(section).not.toContainText("Allergens incomplete");
  await expect(section).toContainText("Wheat");
});

test("a manager merges a duplicate profile and then erases the guest", async ({ browser }) => {
  test.setTimeout(90_000);

  const keptName = `Ben E2E ${setup.suffix}`;
  const kept = await profileFor(setup, keptName);
  const duplicate = await profileFor(setup, `Ben E2E dup ${setup.suffix}`);
  const manager = await signedIn(browser, setup.manager);

  await manager.goto(`/host/guests/${duplicate.id}`);

  const merge = manager.getByRole("region", { name: "Merge into another profile" });

  await merge.getByLabel("Find a guest profile").fill(keptName);
  await merge.getByRole("button", { name: new RegExp(`^${keptName} #${kept.profileNumber}`) }).click();
  await merge.getByLabel("Reason").fill("Same guest");
  await merge.getByRole("button", { name: "Merge" }).click();
  await manager.getByRole("dialog", { name: "Merge these profiles?" }).getByRole("button", { name: "Merge profiles" }).click();
  await expect(manager).toHaveURL(new RegExp(`/host/guests/${kept.id}$`));

  // Managers can merge but not erase; the owner erases.
  await expect(manager.getByRole("region", { name: "Erase this guest" })).toHaveCount(0);

  const owner = await signedIn(browser, setup.owner);

  await owner.goto(`/host/guests/${kept.id}`);

  const erase = owner.getByRole("region", { name: "Erase this guest" });

  await erase.getByLabel("Reason").fill("Guest asked to be forgotten");
  await erase.getByRole("button", { name: "Erase personal data" }).click();
  await expect(owner.getByRole("heading", { level: 1 })).toContainText("Erased guest");
});
