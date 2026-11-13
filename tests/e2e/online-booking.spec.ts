import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type Page } from "@playwright/test";

import type { OrdersAccount } from "../helpers/e2e-orders";
import {
  capturedFor,
  createOnlineSetup,
  disableOnlineAccounts,
  uniquePhone,
  type OnlineSetup,
} from "../helpers/e2e-online-booking";

// Phase 22: a manager turns on online booking; a signed-out guest books with a peanut allergy
// and text consent; the confirmation is captured; the host sees the booking and its message
// history; the guest cancels through the private link; the waitlist table-ready text, and
// what the host sees when the guest gave no consent.

test.describe.configure({ mode: "serial" });
test.use({ timezoneId: "America/Detroit" });

let setup: OnlineSetup;
const guest = { name: "", phone: uniquePhone() };
let manageUrl = "";

function tomorrow(): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Detroit", year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(Date.now() + 86_400_000),
  );

  return parts;
}

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
  setup = await createOnlineSetup();
  guest.name = `Ana Online ${setup.suffix}`;
});

test.afterAll(async () => {
  await disableOnlineAccounts();
});

test("a closed location's booking page says online booking isn't available", async ({ page }) => {
  await page.goto(`/book/${setup.code}`);
  await expect(page.getByRole("heading", { name: "Online booking isn't available" })).toBeVisible();
  await page.goto("/book/no-such-place");
  await expect(page.getByRole("heading", { name: "Online booking isn't available" })).toBeVisible();
});

test("a manager turns on online booking with evening hours", async ({ browser }) => {
  const manager = await signedIn(browser, setup.manager);

  await manager.goto("/host/online-booking");

  const settings = manager.getByRole("form", { name: "Online booking settings" });

  await settings.getByLabel("Take bookings online").check();
  await settings.getByRole("button", { name: "Save settings" }).click();
  await expect(settings.getByLabel("Take bookings online")).toBeChecked();
  await manager.getByRole("button", { name: "Every day 17:00 to 21:00" }).click();
  await manager.getByRole("button", { name: "Save hours" }).click();
  await expect(manager.getByRole("list", { name: "Booking hours" }).getByRole("listitem")).toHaveCount(7);
  await expect(manager.getByText(`/book/${setup.code}`)).toBeVisible();
});

test("a signed-out guest books a table with a peanut allergy and text consent, and gets the text", async ({ page }) => {
  test.setTimeout(90_000);

  await page.goto(`/book/${setup.code}`);

  const form = page.getByRole("form", { name: "Book a table" });

  // Tomorrow, so the evening is bookable whatever the time of day the suite runs (Phase 23
  // fix: today's 19:00 is inside the two-hour lead time once it is past 17:00 here).
  // Under `next dev` a fill before hydration is reset to today, so fill until it holds.
  await expect(async () => {
    await form.getByLabel("Date").fill(tomorrow());
    await expect(page.getByRole("button", { name: "19:00" })).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 30_000 });

  // Phase 15 standard: no serious or critical WCAG 2.1 A/AA violations on the guest page.
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();

  expect(
    axe.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical").map((violation) => violation.id),
  ).toEqual([]);

  await form.getByLabel("Guests").selectOption("4");
  await form.getByRole("button", { name: "19:00" }).click();
  await form.getByLabel("Name").fill(guest.name);
  await form.getByLabel("Mobile phone").fill(guest.phone.typed);
  await form.getByLabel("Text me about this booking").check();
  await form.getByLabel("Peanuts").check();
  await form.getByLabel("severe").check();
  await form.getByRole("button", { name: "Book table" }).click();

  const booked = page.getByRole("region", { name: "Booking made" });

  await expect(booked).toContainText("Your table is booked.");
  manageUrl = (await booked.getByRole("link").getAttribute("href"))!;
  expect(manageUrl).toMatch(/\/book\/manage\/[A-Za-z0-9_-]{43}$/);

  // The dispatcher sends after commit; the capture adapter writes the text to a file.
  await expect
    .poll(async () => (await capturedFor(guest.phone.e164)).map((message) => message.body).join("\n"), { timeout: 20_000 })
    .toMatch(/Your reservation for 4 guests on .+ at 7:00 PM is confirmed\. View or cancel: .+ Reply STOP to opt out\./);
  expect((await capturedFor(guest.phone.e164)).every((message) => !message.body.includes("Peanut"))).toBe(true);
});

test("the host sees the online booking, its allergy and its sent confirmation", async ({ browser }) => {
  const host = await signedIn(browser, setup.host);

  await host.goto("/host/reservations");

  const card = host.getByRole("listitem", { name: `Reservation for ${guest.name}` });

  await expect(card).toContainText("Online");
  await expect(card).toContainText("Allergy: Peanuts");
  await card.getByRole("button", { name: "Messages" }).click();

  const panel = card.getByRole("region", { name: "Guest messages" });

  await expect(panel).toContainText("Texts OK");
  await expect(panel.getByRole("list", { name: "Message history" })).toContainText("Confirmation");
  await expect(panel.getByRole("list", { name: "Message history" })).toContainText("Sent");
});

// Phase 24 (Phase 23 gap and policy 18): an open board picks up an online booking and a
// staff booking made elsewhere without a reload.
test("an open reservations board shows new online and staff bookings without a reload", async ({ page, browser }) => {
  test.setTimeout(90_000);

  const host = await signedIn(browser, setup.host);
  const online = `Ben Online ${setup.suffix}`;
  const phoned = `Cara Phoned ${setup.suffix}`;

  await host.goto("/host/reservations");
  await expect(host.getByRole("listitem", { name: `Reservation for ${guest.name}` })).toBeVisible();

  await page.goto(`/book/${setup.code}`);

  const form = page.getByRole("form", { name: "Book a table" });

  await expect(async () => {
    await form.getByLabel("Date").fill(tomorrow());
    await expect(page.getByRole("button", { name: "19:30" })).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
  await form.getByLabel("Guests").selectOption("2");
  await form.getByRole("button", { name: "19:30" }).click();
  await form.getByLabel("Name").fill(online);
  await form.getByLabel("Mobile phone").fill(uniquePhone().typed);
  await form.getByRole("button", { name: "Book table" }).click();
  await expect(page.getByRole("region", { name: "Booking made" })).toContainText("Your table is booked.");

  // Well inside the 30-second fallback refresh, so this is the realtime event.
  await expect(host.getByRole("listitem", { name: `Reservation for ${online}` })).toBeVisible({ timeout: 15_000 });

  // Another device of the staff books by phone.
  const other = await signedIn(browser, setup.host);
  const created = await other.request.post("/api/reservations", {
    data: { guestName: phoned, partySize: 3, localDate: tomorrow(), localTime: "18:00", source: "PHONE" },
  });

  expect(created.status()).toBe(201);
  await expect(host.getByRole("listitem", { name: `Reservation for ${phoned}` })).toBeVisible({ timeout: 15_000 });
});

test("the guest cancels through the private link, and the host sees it cancelled", async ({ page, browser }) => {
  test.setTimeout(90_000);

  await page.goto(manageUrl);
  await expect(page.getByTestId("booking-status")).toHaveText("Confirmed");
  await page.getByRole("button", { name: "Cancel booking" }).click();
  await page.getByRole("button", { name: "Yes, cancel my booking" }).click();
  await expect(page.getByTestId("booking-status")).toHaveText("Cancelled");

  await expect
    .poll(async () => (await capturedFor(guest.phone.e164)).some((message) => message.body.includes("is cancelled")), { timeout: 20_000 })
    .toBe(true);

  const host = await signedIn(browser, setup.host);

  await host.goto("/host/reservations");
  await host.getByLabel("Show completed, cancelled and no-shows").check();
  await expect(host.getByRole("listitem", { name: `Reservation for ${guest.name}` })).toContainText("Cancelled");

  await page.goto(`/book/manage/${"A".repeat(43)}`);
  await expect(page.getByRole("heading", { name: "This link isn't valid" })).toBeVisible();
});

test("the host notifies a waiting walk-in who agreed to texts, and the table-ready text goes out", async ({ browser }) => {
  test.setTimeout(90_000);

  const walkIn = { name: `Ben Walkin ${setup.suffix}`, phone: uniquePhone() };
  const host = await signedIn(browser, setup.host);

  await host.goto("/host/waitlist");

  const addForm = host.getByRole("form", { name: "Add walk-in" });

  await addForm.getByLabel("Guest name").fill(walkIn.name);
  await addForm.getByLabel("Phone (optional)").fill(walkIn.phone.typed);
  await addForm.getByLabel("Guest agreed to texts").check();
  await addForm.getByRole("button", { name: "Add to waitlist" }).click();

  const card = host.getByRole("listitem", { name: `Waitlist entry for ${walkIn.name}` });

  await card.getByRole("button", { name: "Notify (sends table-ready message)" }).click();
  await expect(card).toContainText("table-ready text sent to the guest");
  await expect
    .poll(async () => (await capturedFor(walkIn.phone.e164)).map((message) => message.body), { timeout: 20_000 })
    .toContain(`Harbor E2E ${setup.suffix}: Your table is ready. Please come to the host stand. Reply STOP to opt out.`);
});

test("without consent, Notify sends nothing and tells the host to speak to the guest", async ({ browser }) => {
  const walkIn = { name: `Cy Noconsent ${setup.suffix}`, phone: uniquePhone() };
  const host = await signedIn(browser, setup.host);

  await host.goto("/host/waitlist");

  const addForm = host.getByRole("form", { name: "Add walk-in" });

  await addForm.getByLabel("Guest name").fill(walkIn.name);
  await addForm.getByLabel("Phone (optional)").fill(walkIn.phone.typed);
  await addForm.getByRole("button", { name: "Add to waitlist" }).click();

  const card = host.getByRole("listitem", { name: `Waitlist entry for ${walkIn.name}` });

  await card.getByRole("button", { name: "Mark notified" }).click();
  await expect(card).toContainText("no texts or emails agreed: tell the guest in person");
  // Give the dispatcher a few passes, then confirm nothing was captured for this number.
  await host.waitForTimeout(1500);
  expect(await capturedFor(walkIn.phone.e164)).toEqual([]);
});
