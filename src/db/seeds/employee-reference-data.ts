import { certificationTypes, organizations, positions } from "../schema";
import type { Seed } from "./run-seeds";

/** Jobs, not security roles: a code here grants nothing and holds no wage. */
const POSITIONS = [
  { code: "GENERAL_MANAGER", name: "General Manager" },
  { code: "MANAGER", name: "Manager" },
  { code: "SERVER", name: "Server" },
  { code: "BARTENDER", name: "Bartender" },
  { code: "HOST", name: "Host" },
  { code: "COOK", name: "Cook" },
  { code: "WAIT_STAFF", name: "Wait Staff" },
  { code: "INVENTORY_MANAGER", name: "Inventory Manager" },
] as const;

/** Generic on purpose: no jurisdiction-specific requirements are encoded. */
const CERTIFICATION_TYPES = [
  {
    code: "FOOD_SAFETY",
    name: "Food Safety",
    expirationRequired: true,
    warningDays: 30,
  },
  {
    code: "ALCOHOL_SERVICE",
    name: "Alcohol Service",
    expirationRequired: true,
    warningDays: 30,
  },
] as const;

/** Reference data only. Employee records are never seeded. */
export const employeeReferenceDataSeed: Seed = {
  key: "employees.reference-data",
  run: async (transaction) => {
    const [organization, ...others] = await transaction
      .select({ id: organizations.id })
      .from(organizations);

    if (!organization || others.length > 0) {
      throw new Error("The employee seed needs exactly one organization.");
    }

    await transaction
      .insert(positions)
      .values(
        POSITIONS.map((position) => ({
          ...position,
          organizationId: organization.id,
        })),
      )
      .onConflictDoNothing({
        target: [positions.organizationId, positions.code],
      });

    await transaction
      .insert(certificationTypes)
      .values(
        CERTIFICATION_TYPES.map((type) => ({
          ...type,
          organizationId: organization.id,
        })),
      )
      .onConflictDoNothing({
        target: [certificationTypes.organizationId, certificationTypes.code],
      });
  },
};
