import { boolean, uuid } from "drizzle-orm/pg-core";

/** Database-generated random UUID. Human-readable numbers are separate columns. */
export function uuidPrimaryKey() {
  return uuid("id").primaryKey().defaultRandom();
}

/**
 * For configurable records that are deactivated rather than deleted. Not for
 * transactional or append-only tables, which use status, reversal or history.
 */
export function activeColumn() {
  return boolean("active").notNull().default(true);
}
