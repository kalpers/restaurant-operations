import { count, eq } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import {
  withTransaction,
  type DatabaseExecutor,
} from "@/db/transactions/transaction-context";

import {
  clearFixtureTables,
  createFixtureTables,
  dropFixtureTables,
  fixtureChildren,
  fixtureParents,
} from "../../fixtures/convention-fixtures";

// Stand-ins for operations owned by different domains. Each accepts an executor,
// the same way future repositories will.
async function createParent(executor: DatabaseExecutor, code: string) {
  const [row] = await executor
    .insert(fixtureParents)
    .values({ code, label: code })
    .returning();

  if (!row) {
    throw new Error("Expected a fixture row");
  }

  return row;
}

async function createChild(executor: DatabaseExecutor, parentId: string) {
  await executor.insert(fixtureChildren).values({ parentId });
}

async function countRows() {
  const database = getDatabase();
  const [parents] = await database.select({ total: count() }).from(fixtureParents);
  const [children] = await database.select({ total: count() }).from(fixtureChildren);

  return { parents: parents?.total, children: children?.total };
}

describe("withTransaction", () => {
  beforeAll(async () => {
    await createFixtureTables(getDatabase());
  });

  beforeEach(async () => {
    await clearFixtureTables(getDatabase());
  });

  afterAll(async () => {
    await dropFixtureTables(getDatabase());
    await closeDatabase();
  });

  it("commits every operation and returns the callback's result", async () => {
    const parent = await withTransaction(getDatabase(), async (transaction) => {
      const created = await createParent(transaction, "A");
      await createChild(transaction, created.id);
      await createParent(transaction, "B");
      return created;
    });

    expect(parent.code).toBe("A");
    expect(await countRows()).toEqual({ parents: 2, children: 1 });
  });

  it("rolls back every operation when the callback throws", async () => {
    const failure = new Error("deliberate failure");

    await expect(
      withTransaction(getDatabase(), async (transaction) => {
        const created = await createParent(transaction, "A");
        await createChild(transaction, created.id);
        await createParent(transaction, "B");
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(await countRows()).toEqual({ parents: 0, children: 0 });
  });

  it("rolls back earlier work when a later constraint fails", async () => {
    await expect(
      withTransaction(getDatabase(), async (transaction) => {
        await createParent(transaction, "A");
        await createParent(transaction, "A");
      }),
    ).rejects.toThrow();

    expect(await countRows()).toEqual({ parents: 0, children: 0 });
  });

  it("shares one unit of work across operations, invisible until commit", async () => {
    const database = getDatabase();

    await withTransaction(database, async (transaction) => {
      const parent = await createParent(transaction, "A");
      await createChild(transaction, parent.id);

      // The transaction sees its own work.
      const [inside] = await transaction
        .select({ total: count() })
        .from(fixtureChildren)
        .where(eq(fixtureChildren.parentId, parent.id));
      expect(inside?.total).toBe(1);

      // Other connections do not, which proves the operations shared the transaction.
      expect(await countRows()).toEqual({ parents: 0, children: 0 });
    });

    expect(await countRows()).toEqual({ parents: 1, children: 1 });
  });

  it("lets the same operations run outside a transaction", async () => {
    const parent = await createParent(getDatabase(), "A");
    await createChild(getDatabase(), parent.id);

    expect(await countRows()).toEqual({ parents: 1, children: 1 });
  });
});
