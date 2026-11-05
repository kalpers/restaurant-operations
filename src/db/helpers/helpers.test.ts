import { getTableConfig, pgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { ConcurrencyError } from "../../shared/errors/concurrency-error";
import { activeColumn, uuidPrimaryKey } from "./columns";
import { cost, money, quantity } from "./numeric";
import { businessDate, createdAt, timestamptz, updatedAt } from "./timestamps";
import { assertVersionMatched, versionColumn } from "./versioning";

const { columns } = getTableConfig(
  pgTable("helper_probe", {
    id: uuidPrimaryKey(),
    active: activeColumn(),
    price: money("price"),
    unitCost: cost("unit_cost"),
    onHand: quantity("on_hand"),
    occurredAt: timestamptz("occurred_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    businessDate: businessDate(),
    version: versionColumn(),
  }),
);

function column(name: string) {
  const found = columns.find((candidate) => candidate.name === name);

  if (!found) {
    throw new Error(`No column named ${name}`);
  }

  return found;
}

describe("database column conventions", () => {
  it.each([
    ["id", "uuid"],
    ["active", "boolean"],
    ["price", "numeric(12, 2)"],
    ["unit_cost", "numeric(14, 4)"],
    ["on_hand", "numeric(14, 4)"],
    ["occurred_at", "timestamp with time zone"],
    ["created_at", "timestamp with time zone"],
    ["updated_at", "timestamp with time zone"],
    ["business_date", "date"],
    ["version", "integer"],
  ])("%s uses %s", (name, sqlType) => {
    expect(column(name).getSQLType()).toBe(sqlType);
  });

  it("generates the primary key in the database", () => {
    expect(column("id").primary).toBe(true);
    expect(column("id").hasDefault).toBe(true);
  });

  it("makes version required and starts it at 1", () => {
    expect(column("version").notNull).toBe(true);
    expect(column("version").default).toBe(1);
  });

  it("makes active required and defaults it to true", () => {
    expect(column("active").notNull).toBe(true);
    expect(column("active").default).toBe(true);
  });

  it("does not make numeric or instant columns required by default", () => {
    expect(column("price").notNull).toBe(false);
    expect(column("occurred_at").notNull).toBe(false);
  });
});

describe("assertVersionMatched", () => {
  it("returns the updated row", () => {
    const row = { id: "a", version: 2 };

    expect(assertVersionMatched([row], { type: "record", id: "a" })).toBe(row);
  });

  it("throws a ConcurrencyError when no row was updated", () => {
    const check = () => assertVersionMatched([], { type: "record", id: "a" });

    expect(check).toThrow(ConcurrencyError);
    expect(check).toThrow(
      expect.objectContaining({
        code: "CONCURRENCY_CONFLICT",
        entityType: "record",
        entityId: "a",
      }),
    );
  });
});
