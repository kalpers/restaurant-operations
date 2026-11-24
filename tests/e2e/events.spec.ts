import { expect, test, type Browser, type Page } from "@playwright/test";

import { createBriefingsSetup, disableBriefingsAccounts, type BriefingsSetup } from "../helpers/e2e-briefings";
import { createEventSpace } from "../helpers/e2e-events";
import type { E2eScope, OrdersAccount } from "../helpers/e2e-orders";
import { expandNavGroups, signInWithRetry } from "../helpers/e2e-ui";

// Phase 36 part 3: a manager books the private room for an event starting soon and confirms
// it; a reservation on one of its tables at that time is refused; the event is seated as one
// session from its page.

test.describe.configure({ mode: "serial" });
test.use({ timezoneId: "America/Detroit" });

const SCOPE: E2eScope = { emailDomain: "events-e2e.example.test", rolePrefix: "EVENTS_E2E_", tablePrefix: "EVT-" };

let setup: BriefingsSetup;
let space: Awaited<ReturnType<typeof createEventSpace>>;

async function signedIn(browser: Browser, account: OrdersAccount): Promise<Page> {
  const page = await (await browser.newContext({ timezoneId: "America/Detroit" })).newPage();

  await signInWithRetry(page, account);
  expect((await page.request.put("/api/session/location", { data: { locationId: setup.locationId } })).ok()).toBe(true);

  return page;
}

/** Local date and HH:MM in Detroit, an offset from now. */
function detroit(minutesFromNow: number) {
  const at = new Date(Date.now() + minutesFromNow * 60_000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Detroit",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const part = (type: string) => parts.find((entry) => entry.type === type)!.value;

  return { date: `${part("year")}-${part("month")}-${part("day")}`, time: `${part("hour")}:${part("minute")}` };
}

test.beforeAll(async () => {
  setup = await createBriefingsSetup(SCOPE);
  space = await createEventSpace(setup);
});

test.afterAll(async () => {
  await disableBriefingsAccounts(SCOPE);
});

test("an event holds the private room, refuses a clashing reservation and is seated", async ({ browser }) => {
  test.setTimeout(120_000);

  const name = `Rehearsal dinner ${setup.suffix}`;
  const start = detroit(-10);
  const end = detroit(170);
  const manager = await signedIn(browser, setup.manager);

  // Events are in the Service group.
  await manager.goto("/dashboard");
  await expandNavGroups(manager);
  await manager.getByRole("link", { name: "Events" }).click();
  await manager.getByRole("link", { name: "Book an event" }).click();

  const form = manager.getByRole("form", { name: "Book an event" });

  await form.getByLabel("Event name").fill(name);
  await form.getByLabel("Status").selectOption("CONFIRMED");
  await form.getByLabel("Contact name").fill("Pat Lee");
  await form.getByLabel("Guests").fill("14");
  await form.getByLabel("Date").fill(start.date);
  await form.getByLabel("Starts").fill(start.time);
  await form.getByLabel("Ends").fill(end.time);
  await form.getByLabel("Setup (minutes)").fill("0");
  await form.getByLabel(`Table ${space.tableNumbers[0]} (8)`).check();
  await form.getByLabel(`Table ${space.tableNumbers[1]} (8)`).check();
  await form.getByRole("button", { name: "Book event" }).click();

  await expect(manager.getByRole("heading", { name: new RegExp(`EV-\\d{6} ${name}`) })).toBeVisible();
  await expect(manager.getByText("Confirmed", { exact: true })).toBeVisible();

  // A reservation on one of its tables during the event is refused.
  const eventPage = manager.url();
  const eventId = eventPage.split("/").at(-1)!;
  const event = (await (await manager.request.get(`/api/events/${eventId}`)).json()) as { tables: { id: string }[] };
  const clash = await manager.request.post("/api/reservations", {
    data: {
      guestName: "Clash Guest",
      partySize: 2,
      localDate: detroit(30).date,
      localTime: detroit(30).time,
      source: "PHONE",
      tableIds: [event.tables[0]!.id],
    },
  });

  expect(clash.status()).toBe(409);
  expect(((await clash.json()) as { error: { code: string } }).error.code).toBe("EVENT_CONFLICT");

  // It shows on the reservation book.
  await manager.goto("/host/reservations");
  await expect(manager.getByRole("region", { name: "Events holding space" }).getByText(name)).toBeVisible();

  // Seat it from its page.
  await manager.goto(eventPage);
  await manager.getByRole("button", { name: "Seat the event" }).click();
  await expect(manager.getByText("Event seated.")).toBeVisible();
  await expect(manager.getByRole("button", { name: "Seat the event" })).toHaveCount(0);
});
