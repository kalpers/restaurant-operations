import { jsonb, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";

import { uuidPrimaryKey } from "../helpers/columns";
import { createdAt } from "../helpers/timestamps";
import { users } from "./auth";
import { organizations } from "./organization";

/**
 * Client idempotency keys for critical retryable commands (README section 23). A row is
 * claimed in the same transaction as the command and holds its response, so a retry of
 * a committed command returns the first outcome and a rolled-back attempt leaves no row.
 */
export const idempotencyRecords = pgTable(
  "idempotency_records",
  {
    id: uuidPrimaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    /** The command, for example `orders.send`. */
    scope: text("scope").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    /** SHA-256 of the canonical request, so a reused key with another request is refused. */
    requestFingerprint: text("request_fingerprint").notNull(),
    response: jsonb("response"),
    createdAt: createdAt(),
  },
  (table) => [
    unique("idempotency_records_org_scope_key_unique").on(
      table.organizationId,
      table.scope,
      table.idempotencyKey,
    ),
  ],
);
