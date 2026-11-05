import { date, timestamp } from "drizzle-orm/pg-core";

/** A real-world instant: `TIMESTAMPTZ`, read and written as a JavaScript `Date`. */
export function timestamptz(name: string) {
  return timestamp(name, { withTimezone: true, mode: "date" });
}

export function createdAt() {
  return timestamptz("created_at").notNull().defaultNow();
}

/** Leave this off append-only tables, which never change. */
export function updatedAt() {
  return timestamptz("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
}

/**
 * A calendar date with no operating-day meaning, such as a hire or effective date:
 * `DATE`, as a `YYYY-MM-DD` string so no timezone conversion can shift it.
 */
export function calendarDate(name: string) {
  return date(name, { mode: "string" });
}

/**
 * A restaurant operating day: `DATE`, read and written as a `YYYY-MM-DD` string so
 * no timezone conversion can shift it. It is separate from the instant, and its
 * value must come from BusinessDateService, never from truncating a timestamp.
 */
export function businessDate(name = "business_date") {
  return date(name, { mode: "string" });
}
