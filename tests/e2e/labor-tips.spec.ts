import { expect, test, type Browser, type Page } from "@playwright/test";

import { assignAt } from "../helpers/e2e-accounts";
import {
  businessDateAt,
  createLaborLocation,
  createWorker,
  detroitLocal,
  disableLaborAccounts,
  insertOpenEntry,
  laborAccount,
  type OrdersAccount,
} from "../helpers/e2e-timeclock";
import { confirmDialog } from "../helpers/e2e-ui";

// Phase 18: the manager's time clock and tip pool, at a location of this spec's own (so other
// specs' open checks on MAIN never block finalizing), and what a Server may not reach.

test.describe.configure({ mode: "serial" });
test.use({ timezoneId: "America/Detroit" });

async function signedIn(browser: Browser, account: OrdersAccount, locationId?: string): Promise<Page> {
  const page = await (await browser.newContext({ timezoneId: "America/Detroit" })).newPage();

  await page.goto("/login");
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);

  if (locationId) {
    expect((await page.request.put("/api/session/location", { data: { locationId } })).ok()).toBe(true);
  }

  return page;
}

test.afterAll(async () => {
  await disableLaborAccounts();
});

test("a manager punches for staff without a login, fixes a missed clock-out and finalizes tips", async ({ browser }) => {
  test.setTimeout(120_000);

  const locationId = await createLaborLocation();
  const manager = await laborAccount("MANAGER");

  await assignAt(manager.id, "MANAGER", locationId);

  const walkIn = await createWorker({ locationId, firstName: "Walkin" });
  const forgetful = await createWorker({ locationId, firstName: "Forgetful" });
  // Clocked in 30 hours ago and never clocked out: a missed clock-out on an earlier day.
  // Minute-aligned, because a datetime-local input has no seconds.
  const clockInAt = new Date(Math.floor((Date.now() - 30 * 3_600_000) / 60_000) * 60_000);
  const missedDate = businessDateAt(clockInAt);

  await insertOpenEntry({ locationId, employeeId: forgetful.id, byUserId: manager.id, clockInAt });

  const page = await signedIn(browser, manager, locationId);

  // 1. The missed clock-out is closed with a time and a reason.
  await page.goto("/scheduling/time-clock");

  const missed = page.getByRole("region", { name: "Missed clock-outs" });

  await expect(missed).toContainText(forgetful.name);
  await missed.getByText("Adjust, edit breaks or void").click();
  await missed.getByLabel("Clock-out (leave blank to keep)").fill(detroitLocal(new Date(clockInAt.getTime() + 6 * 3_600_000)));
  await missed.getByLabel("Reason").fill("Forgot to clock out");
  await missed.getByRole("button", { name: "Save correction" }).click();
  await expect(page.getByRole("region", { name: "Missed clock-outs" })).toHaveCount(0);

  // 2. Someone with no login is clocked in, then out, by the manager.
  const clockIn = page.getByRole("form", { name: "Clock someone in" });

  await clockIn.getByLabel("Employee").selectOption({ label: `${walkIn.name} (${walkIn.employeeNumber})` });
  await clockIn.getByRole("button", { name: "Clock in" }).click();

  const onClock = page.getByRole("region", { name: "On the clock" });

  await expect(onClock.getByRole("row").filter({ hasText: walkIn.name })).toBeVisible();
  await onClock.getByRole("row").filter({ hasText: walkIn.name }).getByRole("button", { name: "Clock out" }).click();
  await confirmDialog(page, "Clock out");
  await expect(onClock.getByRole("row").filter({ hasText: walkIn.name })).toHaveCount(0);

  // 3. The corrected entry shows as adjusted, with 6 hours.
  await page.goto(`/scheduling/time-clock?date=${missedDate}`);

  const entry = page.getByTestId("time-entry").filter({ hasText: forgetful.name });

  await expect(entry).toContainText("Adjusted");
  await expect(entry).toContainText("6.00 h");

  // 3b. Phase 20 (policy 10): a 30-minute unpaid break is added on the time clock.
  await entry.getByText("Adjust, edit breaks or void").click();

  const breaks = entry.getByRole("form", { name: "Edit breaks" });

  await breaks.getByRole("button", { name: "Add a break" }).click();
  await breaks.getByLabel("Start").fill(detroitLocal(new Date(clockInAt.getTime() + 2 * 3_600_000)));
  await breaks.getByLabel("End").fill(detroitLocal(new Date(clockInAt.getTime() + 2.5 * 3_600_000)));
  await breaks.getByLabel("Why change the breaks?").fill("Lunch was missed off");
  await breaks.getByRole("button", { name: "Save breaks" }).click();
  await expect(page.getByTestId("time-entry").filter({ hasText: forgetful.name })).toContainText("5.50 h");
  await expect(page.getByTestId("time-entry").filter({ hasText: forgetful.name })).toContainText("1 break(s)");

  // 4. The pool is set up, and that day's tips are finalized (no checks there: shares are $0.00).
  await page.goto(`/tips?date=${missedDate}`);

  const pool = page.getByRole("form", { name: "Tip pool" });

  await pool.getByLabel("Pool tips at this location").check();
  await pool.getByLabel("Server points").fill("10");
  await pool.getByRole("button", { name: "Save tip pool" }).click();

  const distribute = page.getByRole("region", { name: "Distribute tips" });

  await expect(distribute.getByRole("row").filter({ hasText: forgetful.name })).toContainText("5.5000");
  await distribute.getByRole("button", { name: "Finalize tips" }).click();
  await confirmDialog(page, "Finalize");
  await expect(distribute).toContainText("Finalized");
  await expect(page.getByRole("region", { name: "Distribution history" })).toContainText(missedDate);

  // 5. Hours on a finalized date are frozen: the correction form is refused.
  await page.goto(`/scheduling/time-clock?date=${missedDate}`);

  const frozen = page.getByTestId("time-entry").filter({ hasText: forgetful.name });

  await frozen.getByText("Adjust, edit breaks or void").click();
  await frozen.getByLabel("Reason", { exact: true }).fill("Try again");
  await frozen.getByLabel("Clock-out (leave blank to keep)").fill(detroitLocal(new Date(clockInAt.getTime() + 5 * 3_600_000)));
  await frozen.getByRole("button", { name: "Save correction" }).click();
  await expect(frozen).toContainText("finalized");
});

test("a server clocks in on My time but can't reach the time clock, tips or the Tips report", async ({ browser }) => {
  const server = await laborAccount("SERVER");
  const page = await signedIn(browser, server);

  await page.goto("/my-time");
  await expect(page.getByText("Your login isn't linked to an employee record")).toBeVisible();

  for (const path of ["/scheduling/time-clock", "/tips", "/reports/tips"]) {
    await page.goto(path);
    await expect(page, path).toHaveURL(/\/access-denied/);
  }

  for (const url of ["/api/timeclock/board", "/api/tips/rule", "/api/tips/distributions?from=2026-01-01&to=2026-01-02"]) {
    expect((await page.request.get(url)).status(), url).toBe(403);
  }

  expect(
    (
      await page.request.post("/api/timeclock/clock-in", {
        data: { employeeId: "00000000-0000-4000-8000-000000000000", idempotencyKey: "e2e_refused_manager_punch" },
      })
    ).status(),
  ).toBe(403);
});
