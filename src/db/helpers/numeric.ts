import { numeric } from "drizzle-orm/pg-core";

// Drizzle returns these as decimal strings such as "0.1000". Keep them as strings:
// converting to a JavaScript number loses exactness. PostgreSQL silently rounds
// extra decimal places to the column's scale, so domains must validate input scale.

/** Customer-facing money: `NUMERIC(12,2)`. */
export function money(name: string) {
  return numeric(name, { precision: 12, scale: 2, mode: "string" });
}

/** Detailed ingredient, inventory and supplier cost: `NUMERIC(14,4)`. */
export function cost(name: string) {
  return numeric(name, { precision: 14, scale: 4, mode: "string" });
}

/** Inventory quantity: `NUMERIC(14,4)`. Positive adds stock, negative removes it. */
export function quantity(name: string) {
  return numeric(name, { precision: 14, scale: 4, mode: "string" });
}
