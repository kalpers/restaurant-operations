import { prepareTestDatabase } from "./prepare-test-database";

/** Runs once before a Vitest integration run or a Playwright run. */
export default async function globalSetup(): Promise<void> {
  await prepareTestDatabase();
}
