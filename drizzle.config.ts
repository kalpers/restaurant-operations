import { defineConfig } from "drizzle-kit";

import { getEnv } from "./src/config/env";
import { loadLocalEnv } from "./src/config/tooling-env";

loadLocalEnv();

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/index.ts",
  out: "./drizzle/migrations",
  dbCredentials: {
    url: getEnv().DATABASE_URL,
  },
});
