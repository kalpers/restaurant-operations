import { pgTable, text } from "drizzle-orm/pg-core";

import { uuidPrimaryKey } from "../helpers/columns";
import { timestamptz } from "../helpers/timestamps";

/** Infrastructure only: records which stable seed keys have run. */
export const seedRuns = pgTable("seed_runs", {
  id: uuidPrimaryKey(),
  seedKey: text("seed_key").notNull().unique(),
  appliedAt: timestamptz("applied_at").notNull().defaultNow(),
});
