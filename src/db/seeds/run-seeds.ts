import type { Database } from "../index";
import { seedRuns } from "../schema/seed-runs";
import {
  withTransaction,
  type DatabaseTransaction,
} from "../transactions/transaction-context";

export type Seed = {
  /** Stable forever. To change seeded data later, add a seed with a new key. */
  key: string;
  run: (transaction: DatabaseTransaction) => Promise<void>;
};

export type SeedResult = {
  applied: string[];
  skipped: string[];
};

/**
 * Runs each seed in its own transaction, in order. The key is claimed first, so a
 * seed runs only if its key is new. A failing seed rolls back its data and its key,
 * then stops the run; seeds that finished before it stay applied.
 */
export async function runSeeds(
  database: Database,
  seeds: readonly Seed[],
): Promise<SeedResult> {
  const keys = seeds.map((seed) => seed.key);
  const duplicate = keys.find((key, index) => keys.indexOf(key) !== index);

  if (duplicate) {
    throw new Error(`Duplicate seed key: ${duplicate}`);
  }

  const result: SeedResult = { applied: [], skipped: [] };

  for (const seed of seeds) {
    const applied = await withTransaction(database, async (transaction) => {
      const claimed = await transaction
        .insert(seedRuns)
        .values({ seedKey: seed.key })
        .onConflictDoNothing({ target: seedRuns.seedKey })
        .returning({ id: seedRuns.id });

      if (claimed.length === 0) {
        return false;
      }

      await seed.run(transaction);
      return true;
    });

    (applied ? result.applied : result.skipped).push(seed.key);
  }

  return result;
}
