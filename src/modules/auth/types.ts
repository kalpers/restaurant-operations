import type { PermissionCode } from "./permission-catalog";

export type AuthorizedLocation = {
  locationId: string;
  locationCode: string;
  locationName: string;
  organizationId: string;
  roles: { id: string; code: string; name: string }[];
  permissions: PermissionCode[];
};

/** The signed-in user as the application sees them. Holds no credential data. */
export type AuthContext = {
  userId: string;
  email: string;
  active: true;
  /** Set by an administrator's reset: every guard sends the user to change it first. */
  mustChangePassword: boolean;
  locations: AuthorizedLocation[];
};

/** Who is acting and what they hold at the location being acted on. */
export type Actor = {
  userId: string;
  organizationId: string;
  locationId: string;
  permissions: ReadonlySet<string>;
};
