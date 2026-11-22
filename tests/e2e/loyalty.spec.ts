import { expect, test, type Browser, type Page } from "@playwright/test";

import { createGuestsSetup, disableGuestsAccounts, profileFor, type GuestsSetup } from "../helpers/e2e-guests";
import { endVisit, linkedVisit, orderSubtotal, settleCheck, turnLoyaltyOff } from "../helpers/e2e-loyalty";
import type { OrdersAccount } from "../helpers/e2e-orders";
import { expandNavGroups, signInWithRetry } from "../helpers/e2e-ui";

// Phase 30: a manager turns loyalty on and adds a reward; a linked visit earns when its session
// ends; on the next visit the server redeems the reward, and the points leave at close.

test.describe.configure({ mode: "serial" });
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
  await turnLoyaltyOff(setup);
  await disableGuestsAccounts(setup);
});

test("a manager turns loyalty on, a visit earns at session end, and a reward is redeemed and posted at close", async ({
  browser,
}) => {
  test.setTimeout(180_000);

  const manager = await signedIn(browser, setup.manager);

  // The Loyalty page is in the Service group for loyalty.manage holders.
  await manager.goto("/dashboard");
  await expandNavGroups(manager);
  await manager.getByRole("link", { name: "Loyalty" }).click();
  await expect(manager.getByRole("heading", { name: /Loyalty/ })).toBeVisible();

  const program = manager.getByRole("region", { name: "Program" });

  await program.getByLabel("Guests earn and redeem points").check();
  await program.getByLabel("Points per $1 of subtotal (0 to 100)").fill("1");
  await program.getByLabel("Points per visit (0 to 100)").fill("1");
  await program.getByRole("button", { name: "Save program" }).click();
  await expect(manager.getByText("Saved.")).toBeVisible();

  const rewardName = `Free bread ${setup.suffix}`;
  const newReward = manager.getByRole("region", { name: "New reward" });

  await newReward.getByLabel("Name").fill(rewardName);
  await newReward.getByLabel("Points it costs").fill("5");
  await newReward.getByLabel("Applies to").selectOption("ITEM");
  await newReward.getByLabel("Type").selectOption("PERCENTAGE");
  await newReward.getByLabel("Value (percent or dollars; 100% is free)").fill("100");
  await newReward.getByRole("button", { name: "Create reward" }).click();
  await expect(manager.getByText("Reward created.")).toBeVisible();
  await manager.reload();
  await expect(manager.getByRole("listitem", { name: `Reward ${rewardName}` })).toContainText("5 points");

  // First visit: the satay ($12) is closed and the guests leave.
  const guest = await profileFor(setup, `Loyal E2E ${setup.suffix}`);
  const first = await linkedVisit(setup, guest.id, setup.satay.id);

  await settleCheck(setup, first.orderId);
  await endVisit(setup, first.sessionId);

  const earned = Math.floor(Number(await orderSubtotal(first.orderId))) + 1;

  await manager.goto(`/host/guests/${guest.id}`);

  const points = manager.getByRole("region", { name: "Loyalty points" });

  await expect(points.getByTestId("loyalty-balance")).toHaveText(String(earned));
  await expect(points).toContainText("Earned on $");

  // Second visit: the server redeems the free bread on the check.
  const second = await linkedVisit(setup, guest.id, setup.bread.id);
  const server = await signedIn(browser, setup.server);

  await server.goto(`/orders/${second.orderId}`);

  const loyalty = server.getByRole("region", { name: "Loyalty" });

  await expect(loyalty.getByTestId("order-loyalty-available")).toHaveText(String(earned));

  const redeem = loyalty.getByRole("form", { name: "Redeem a reward" });

  await redeem.getByLabel("Reward").selectOption({ label: `${rewardName} · 5 pts · 100.00% off` });
  await redeem.getByLabel("Item").selectOption({ label: setup.bread.name });
  await redeem.getByRole("button", { name: "Redeem" }).click();
  await expect(server.getByText(`${rewardName} applied.`)).toBeVisible();
  await expect(server.getByText(`Loyalty: ${rewardName}`)).toBeVisible();
  await expect(loyalty.getByTestId("order-loyalty-available")).toHaveText(String(earned - 5));

  // Pending until the check closes; then the points leave.
  await manager.reload();
  await expect(points.getByTestId("loyalty-balance")).toHaveText(String(earned));
  await expect(points.getByTestId("loyalty-available")).toHaveText(String(earned - 5));

  await settleCheck(setup, second.orderId);
  await manager.reload();
  await expect(points.getByTestId("loyalty-balance")).toHaveText(String(earned - 5));
  await expect(points).toContainText("Reward used on check #");
});

// Phase 33 (policies 7, 8): a refund takes back the points it paid for; the visit points stay.
test("a refund on a linked visit takes back its points", async ({ browser }) => {
  test.setTimeout(180_000);

  const guest = await profileFor(setup, `Refund E2E ${setup.suffix}`);
  const visit = await linkedVisit(setup, guest.id, setup.satay.id);

  await settleCheck(setup, visit.orderId);
  await endVisit(setup, visit.sessionId);

  const subtotal = Number(await orderSubtotal(visit.orderId));
  const earned = Math.floor(subtotal) + 1;
  const taken = Math.floor(subtotal) - Math.floor(subtotal - 5);
  const manager = await signedIn(browser, setup.manager);

  await manager.goto(`/orders/${visit.orderId}/settlement`);

  const refund = manager.getByRole("form", { name: "Record refund" });

  await refund.getByLabel("Amount refunded (with tax)").fill("5.00");
  await refund.getByLabel("Reason").fill("Satay was cold");
  await refund.getByRole("button", { name: "Record refund" }).click();
  await expect(manager.getByTestId("refund-points-notice")).toHaveText(`${taken} loyalty points were taken back.`);

  await manager.goto(`/host/guests/${guest.id}`);
  await expect(manager.getByRole("region", { name: "Loyalty points" }).getByTestId("loyalty-balance")).toHaveText(String(earned - taken));
  await expect(manager.getByRole("region", { name: "Loyalty points" })).toContainText("Taken back (refund)");
});
