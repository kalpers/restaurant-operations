import { expect, test } from "@playwright/test";

test("home page sends a signed-out visitor to the login page", async ({
  page,
}) => {
  await page.goto("/");

  await expect(page).toHaveURL(/\/login$/);
  await expect(page).toHaveTitle("Restaurant Operations Management System");
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
});

test("health endpoint reports a database connection", async ({ request }) => {
  const response = await request.get("/api/health");

  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({
    status: "ok",
    database: "connected",
  });
});
