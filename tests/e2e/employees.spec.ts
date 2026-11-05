import { randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import {
  createEmployeeRecord,
  createPermissionAccount,
  createRoleAccount,
  linkEmployeeToUser,
  removeHrE2eData,
  uniqueEmployeeNumber,
  type HrE2eAccount,
} from "../helpers/e2e-employees";

async function signIn(page: Page, account: HrE2eAccount) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

const sections = (page: Page) =>
  page.getByRole("navigation", { name: "Employee sections" });

test.afterAll(async () => {
  await removeHrE2eData();
});

test.describe("employee management", () => {
  test("an owner creates an employee, sees them listed, and opens the detail", async ({
    page,
  }) => {
    const owner = await createRoleAccount("OWNER");
    const employeeNumber = uniqueEmployeeNumber();
    const lastName = `Created-${randomUUID()}`;

    await signIn(page, owner);
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Employees", exact: true })
      .click();
    await expect(page.getByRole("heading", { name: "Employees" })).toBeVisible();

    await page.getByLabel("Employee number").fill(employeeNumber);
    await page.getByLabel("First name").fill("Jane");
    await page.getByLabel("Last name").fill(lastName);
    await page.getByLabel("Hire date").fill("2024-01-15");
    await page.getByLabel("Employment type").selectOption("PART_TIME");
    await page.getByLabel("Initial position").selectOption({ label: "Server" });
    await page.getByRole("button", { name: "Create employee" }).click();

    const row = page.getByRole("row").filter({ hasText: employeeNumber });

    await expect(row).toContainText("Main Restaurant");
    await expect(row).toContainText("Server");
    await expect(row).toContainText("Active");
    await expect(row).toContainText("Part time");

    await row.getByRole("link").click();

    await expect(
      page.getByRole("heading", { name: `Jane ${lastName}` }),
    ).toBeVisible();
    await expect(page.getByText("Status:")).toBeVisible();
    await expect(page.getByText("No linked login.")).toBeVisible();
  });

  test("a stale edit is reported rather than overwriting", async ({
    page,
    context,
  }) => {
    const owner = await createRoleAccount("OWNER");
    const id = await createEmployeeRecord(owner);

    await signIn(page, owner);
    await page.goto(`/employees/${id}`);

    const other = await context.newPage();

    await other.goto(`/employees/${id}`);
    await other.getByLabel("Preferred name").first().fill("First");
    await other.getByRole("button", { name: "Save details" }).click();
    await expect(other.getByText("Saved.").first()).toBeVisible();

    await page.getByLabel("Preferred name").first().fill("Second");
    await page.getByRole("button", { name: "Save details" }).click();

    await expect(page.getByText("changed by someone else")).toBeVisible();
  });
});

test.describe("restricted HR", () => {
  test("a general viewer sees no restricted tabs, and direct requests are refused", async ({
    page,
  }) => {
    const owner = await createRoleAccount("OWNER");
    const id = await createEmployeeRecord(owner, { positionCode: "SERVER" });
    const viewer = await createPermissionAccount(["employees.view"]);

    await signIn(page, viewer);
    await page.goto("/employees");
    await expect(
      page.getByRole("columnheader", { name: "Status" }),
    ).toHaveCount(0);

    await page.goto(`/employees/${id}`);

    await expect(sections(page).getByRole("link")).toHaveText(["Overview"]);
    await expect(page.getByText("Status:")).toHaveCount(0);
    await expect(page.getByText("Terminate employee")).toHaveCount(0);

    for (const path of [
      "compensation",
      "personal",
      "disciplinary-actions",
      "performance-reviews",
      "notes",
      "documents",
      "certifications",
      "status-history",
      "user-link",
    ]) {
      const response = await page.request.get(`/api/employees/${id}/${path}`);

      expect(response.status(), path).toBe(403);
    }

    const write = await page.request.post(`/api/employees/${id}/compensation`, {
      data: {
        positionId: randomUUID(),
        compensationType: "HOURLY",
        hourlyRate: "99.00",
        effectiveFrom: "2024-02-01",
      },
    });

    expect(write.status()).toBe(403);

    const general = await page.request.get(`/api/employees/${id}`);
    const body = (await general.json()) as Record<string, unknown>;

    expect(general.status()).toBe(200);
    expect(body).not.toHaveProperty("employmentStatus");
    expect(body).not.toHaveProperty("personalEmail");
    expect(body).not.toHaveProperty("phone");
  });

  test("asking for a restricted tab by URL shows the overview instead", async ({
    page,
  }) => {
    const owner = await createRoleAccount("OWNER");
    const id = await createEmployeeRecord(owner);
    const viewer = await createPermissionAccount(["employees.view"]);

    await signIn(page, viewer);
    await page.goto(`/employees/${id}?tab=compensation`);

    await expect(page.getByRole("heading", { name: "Details" })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Compensation" }),
    ).toHaveCount(0);
  });

  test("a Manager gets the management tier and not the restricted one", async ({
    page,
  }) => {
    const owner = await createRoleAccount("OWNER");
    const id = await createEmployeeRecord(owner);
    const manager = await createRoleAccount("MANAGER");

    await signIn(page, manager);
    await page.goto(`/employees/${id}`);

    await expect(sections(page).getByRole("link")).toHaveText([
      "Overview",
      "Certifications",
      "Notes",
      "Performance",
    ]);
    await expect(page.getByText("Status:")).toBeVisible();

    const compensation = await page.request.get(
      `/api/employees/${id}/compensation`,
    );

    expect(compensation.status()).toBe(403);
  });

  test("a user with no employee permission is refused the area", async ({
    page,
  }) => {
    const server = await createRoleAccount("SERVER");

    await signIn(page, server);
    await expect(
      page.getByRole("navigation", { name: "Main" }).getByRole("link", {
        name: "Employees",
      }),
    ).toHaveCount(0);

    await page.goto("/employees");
    await expect(page).toHaveURL(/\/access-denied$/);

    expect((await page.request.get("/api/employees")).status()).toBe(403);
  });

  test("a signed-out request is refused", async ({ request }) => {
    expect((await request.get("/api/employees")).status()).toBe(401);
  });
});

test.describe("authorized HR access", () => {
  test("an owner records a wage per position as an exact decimal", async ({
    page,
  }) => {
    const owner = await createRoleAccount("OWNER");
    const id = await createEmployeeRecord(owner, { positionCode: "SERVER" });

    await signIn(page, owner);
    await page.goto(`/employees/${id}`);
    await sections(page).getByRole("link", { name: "Compensation" }).click();

    await expect(
      page.getByRole("heading", { name: "Compensation" }),
    ).toBeVisible();

    await page.getByLabel("Position").selectOption({ label: "Server" });
    await page.getByLabel("Pay type").selectOption("HOURLY");
    await page.getByLabel("Hourly rate").fill("9.50");
    await page.getByLabel("Effective date").fill("2024-02-01");
    await page.getByRole("button", { name: "Save wage" }).click();

    await expect(page.getByText("9.50 per hour")).toBeVisible();

    await page.getByLabel("Hourly rate").fill("10.25");
    await page.getByLabel("Position").selectOption({ label: "Server" });
    await page.getByLabel("Pay type").selectOption("HOURLY");
    await page.getByLabel("Effective date").fill("2024-03-01");
    await page.getByRole("button", { name: "Save wage" }).click();

    await expect(page.getByText("10.25 per hour")).toBeVisible();
    await expect(page.getByText("2024-02-01 to 2024-02-29")).toBeVisible();
  });

  test("an owner uploads a sensitive document that downloads only with permission", async ({
    page,
    browser,
  }) => {
    const owner = await createRoleAccount("OWNER");
    const id = await createEmployeeRecord(owner);

    await signIn(page, owner);
    await page.goto(`/employees/${id}?tab=documents`);

    await page.getByLabel("File", { exact: true }).setInputFiles({
      name: "contract.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.7\nfixture"),
    });
    await page.getByLabel("Document type").selectOption("CONTRACT");
    await page.getByRole("button", { name: "Upload document" }).click();

    const link = page.getByRole("link", { name: "contract.pdf" });

    await expect(link).toBeVisible();

    const href = await link.getAttribute("href");
    const download = await page.request.get(href!);

    expect(download.status()).toBe(200);
    expect(await download.text()).toContain("%PDF-1.7");
    expect(download.headers()["content-disposition"]).toContain("attachment");
    expect(download.headers()["x-content-type-options"]).toBe("nosniff");
    expect(download.headers()["cache-control"]).toContain("no-store");

    const context = await browser.newContext();
    const otherPage = await context.newPage();
    const nonSensitiveOnly = await createPermissionAccount([
      "employees.view",
      "hr.documents.view",
    ]);

    await signIn(otherPage, nonSensitiveOnly);

    expect((await otherPage.request.get(href!)).status()).toBe(403);

    await otherPage.goto(`/employees/${id}?tab=documents`);
    await expect(otherPage.getByText("contract.pdf")).toHaveCount(0);

    await context.close();

    // No public route serves the file: signed out, the same URL needs authentication.
    const anonymous = await browser.newContext();

    expect((await anonymous.request.get(href!)).status()).toBe(401);
    await anonymous.close();
  });

  test("an unsupported upload is refused with a clear message", async ({
    page,
  }) => {
    const owner = await createRoleAccount("OWNER");
    const id = await createEmployeeRecord(owner);

    await signIn(page, owner);
    await page.goto(`/employees/${id}?tab=documents`);

    await page.getByLabel("File", { exact: true }).setInputFiles({
      name: "script.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("<script>alert(1)</script>"),
    });
    await page.getByRole("button", { name: "Upload document" }).click();

    await expect(page.getByText("contents don't match")).toBeVisible();
    await expect(page.getByRole("link", { name: "script.pdf" })).toHaveCount(0);
  });
});

test.describe("termination", () => {
  test("terminating a linked employee ends that user's access at once", async ({
    page,
    browser,
  }) => {
    const owner = await createRoleAccount("OWNER");
    const staff = await createRoleAccount("SERVER");
    const id = await createEmployeeRecord(owner, { positionCode: "SERVER" });

    await linkEmployeeToUser(id, staff.id);

    const staffContext = await browser.newContext();
    const staffPage = await staffContext.newPage();

    await signIn(staffPage, staff);
    await expect(staffPage.getByRole("heading", { name: "Dashboard" })).toBeVisible();

    await signIn(page, owner);
    await page.goto(`/employees/${id}`);
    await page.getByLabel("Termination date").fill("2024-06-30");
    await page.getByLabel("Termination reason").fill("Fixture");
    await page.getByRole("button", { name: "Terminate employee" }).click();

    await expect(page.getByText("Terminated on 2024-06-30")).toBeVisible();
    // History is kept: both assignments show their end date.
    await expect(page.getByText("2024-01-15 to 2024-06-30")).toHaveCount(2);

    await staffPage.goto("/dashboard");
    await expect(staffPage).toHaveURL(/\/login$/);

    await staffContext.close();
  });

  test("terminating your own linked employee record is refused", async ({
    page,
  }) => {
    const owner = await createRoleAccount("OWNER");
    const id = await createEmployeeRecord(owner);

    await linkEmployeeToUser(id, owner.id);
    await signIn(page, owner);
    await page.goto(`/employees/${id}`);
    await page.getByLabel("Termination date").fill("2024-06-30");
    await page.getByRole("button", { name: "Terminate employee" }).click();

    await expect(page.getByText("can't terminate your own")).toBeVisible();

    await page.reload();
    await expect(page.getByText("Terminated on")).toHaveCount(0);
  });
});

test.describe("responsive layout", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the list and detail fit a phone without sideways scrolling", async ({
    page,
  }) => {
    const owner = await createRoleAccount("OWNER");
    const id = await createEmployeeRecord(owner, { positionCode: "SERVER" });

    await signIn(page, owner);

    for (const path of ["/employees", `/employees/${id}`]) {
      await page.goto(path);

      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );

      expect(overflow, path).toBeLessThanOrEqual(0);
    }
  });
});
