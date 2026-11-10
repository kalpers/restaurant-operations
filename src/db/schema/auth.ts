import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { activeColumn, uuidPrimaryKey } from "../helpers/columns";
import { createdAt, timestamptz, updatedAt } from "../helpers/timestamps";
import { versionColumn } from "../helpers/versioning";
import { locations, organizations } from "./organization";

/** An application identity. Employment records are a separate, later domain. */
export const users = pgTable(
  "users",
  {
    id: uuidPrimaryKey(),
    email: text("email").notNull(),
    normalizedEmail: text("normalized_email").notNull().unique(),
    username: text("username").unique(),
    passwordHash: text("password_hash").notNull(),
    active: activeColumn(),
    emailVerifiedAt: timestamptz("email_verified_at"),
    lastLoginAt: timestamptz("last_login_at"),
    disabledAt: timestamptz("disabled_at"),
    /** Set by an administrator's reset; every guard sends the user to change it. */
    mustChangePassword: boolean("must_change_password").notNull().default(false),
    /** Sessions signed in before this instant are rejected. Null until a first change. */
    passwordChangedAt: timestamptz("password_changed_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    check(
      "users_active_matches_disabled_at",
      sql`${table.active} = (${table.disabledAt} IS NULL)`,
    ),
  ],
);

/** Software permissions only. Never synchronized with employee positions. */
export const roles = pgTable(
  "roles",
  {
    id: uuidPrimaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    systemRole: boolean("system_role").notNull().default(false),
    active: activeColumn(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: versionColumn(),
  },
  (table) => [
    unique("roles_organization_id_code_unique").on(
      table.organizationId,
      table.code,
    ),
  ],
);

export const permissions = pgTable("permissions", {
  id: uuidPrimaryKey(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  category: text("category").notNull(),
  createdAt: createdAt(),
});

export const rolePermissions = pgTable(
  "role_permissions",
  {
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "restrict" }),
    permissionId: uuid("permission_id")
      .notNull()
      .references(() => permissions.id, { onDelete: "restrict" }),
  },
  (table) => [
    primaryKey({ columns: [table.roleId, table.permissionId] }),
    index("role_permissions_permission_id_idx").on(table.permissionId),
  ],
);

/** A role applies only at its location. Removal deactivates the row. */
export const userRoles = pgTable(
  "user_roles",
  {
    id: uuidPrimaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "restrict" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    assignedAt: timestamptz("assigned_at").notNull().defaultNow(),
    assignedByUserId: uuid("assigned_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    active: activeColumn(),
  },
  (table) => [
    unique("user_roles_user_id_role_id_location_id_unique").on(
      table.userId,
      table.roleId,
      table.locationId,
    ),
    index("user_roles_user_id_location_id_idx").on(
      table.userId,
      table.locationId,
    ),
    index("user_roles_role_id_idx").on(table.roleId),
  ],
);

/**
 * Sign-in throttling (Phase 16). One row per throttle key: an HMAC of a normalized email or
 * a client IP, never the value itself. Counted with one atomic upsert per failure, so the
 * limit holds across restarts and processes. Lockout is always temporary.
 */
export const loginThrottles = pgTable(
  "login_throttles",
  {
    keyHash: text("key_hash").primaryKey(),
    failureCount: integer("failure_count").notNull(),
    windowStartedAt: timestamptz("window_started_at").notNull(),
    lockedUntil: timestamptz("locked_until"),
    updatedAt: timestamptz("updated_at").notNull(),
  },
  (table) => [
    check("login_throttles_failure_count_positive", sql`${table.failureCount} > 0`),
    check("login_throttles_key_hash_format", sql`${table.keyHash} ~ '^[0-9a-f]{64}$'`),
  ],
);
