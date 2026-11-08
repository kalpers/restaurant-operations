import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { uuidPrimaryKey } from "../helpers/columns";
import { createdAt, timestamptz, updatedAt } from "../helpers/timestamps";
import { versionColumn } from "../helpers/versioning";
import { users } from "./auth";
import { locations } from "./organization";

// A Guest Party is the group being served. It stays small and operational: the contact
// fields exist only to run reservations and the waitlist, and aren't a customer profile.

/** The group of guests, from expected arrival through to their visit being completed. */
export const guestParties = pgTable(
  "guest_parties",
  {
    id: uuidPrimaryKey(),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    partySize: integer("party_size").notNull(),
    guestName: text("guest_name").notNull(),
    phone: text("phone"),
    email: text("email"),
    specialRequests: text("special_requests"),
    status: text("status").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    unique("guest_parties_id_location_id_unique").on(table.id, table.locationId),
    check("guest_parties_party_size_positive", sql`${table.partySize} > 0`),
    check(
      "guest_parties_guest_name_not_blank",
      sql`length(trim(${table.guestName})) > 0`,
    ),
    check(
      "guest_parties_status_valid",
      sql`${table.status} IN ('EXPECTED', 'WAITING', 'CHECKED_IN', 'SEATED', 'COMPLETED', 'CANCELLED', 'NO_SHOW')`,
    ),
    index("guest_parties_location_id_status_idx").on(
      table.locationId,
      table.status,
    ),
  ],
);

/** Append-only domain history of a party's status. It isn't the audit domain. */
export const partyStatusHistory = pgTable(
  "party_status_history",
  {
    id: uuidPrimaryKey(),
    guestPartyId: uuid("guest_party_id")
      .notNull()
      .references(() => guestParties.id, { onDelete: "restrict" }),
    status: text("status").notNull(),
    reason: text("reason"),
    changedByUserId: uuid("changed_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    occurredAt: timestamptz("occurred_at").notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (table) => [
    check(
      "party_status_history_status_valid",
      sql`${table.status} IN ('EXPECTED', 'WAITING', 'CHECKED_IN', 'SEATED', 'COMPLETED', 'CANCELLED', 'NO_SHOW')`,
    ),
    index("party_status_history_guest_party_id_occurred_at_idx").on(
      table.guestPartyId,
      table.occurredAt,
    ),
  ],
);
