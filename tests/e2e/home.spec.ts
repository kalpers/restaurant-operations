import { expect, test } from "@playwright/test";

test("home page identifies the application", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveTitle("Restaurant Operations Management System");
  await expect(
    page.getByRole("heading", {
      name: "Restaurant Operations Management System",
    }),
  ).toBeVisible();
  await expect(page.getByText("Development Environment")).toBeVisible();
});

test("health endpoint reports a database connection", async ({ request }) => {
  const response = await request.get("/api/health");

  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({
    status: "ok",
    database: "connected",
  });
});
