import { eq, like } from "drizzle-orm";

import { loadLocalEnv } from "../src/config/tooling-env";
import { closeDatabase, getDatabase } from "../src/db";
import {
  DEMO_AVAILABILITY,
  DEMO_EMPLOYEES,
  DEMO_POSITIONS,
} from "../src/db/demo/demo-employees";
import { employeeAvailability, employees, positions } from "../src/db/schema";
import type { Actor } from "../src/modules/auth/types";
import { assignPosition } from "../src/modules/employees/services/assignment-service";
import { changeCompensation } from "../src/modules/employees/services/compensation-service";
import { createEmployee } from "../src/modules/employees/services/employee-service";
import { updatePersonalContact } from "../src/modules/employees/services/personal-service";
import { createPosition } from "../src/modules/employees/services/reference-service";
import { addRecurringAvailability } from "../src/modules/scheduling/services/availability-service";

import { seedDeclaredAllergens, seedGuestProfiles, seedIngredientAllergens, type DemoProfile } from "./demo-guests-allergens";
import { seedDemoKitchen } from "./demo-kitchen";
import { assertLocalDevelopment, mainOwnerActor } from "./local-seed-guard";

async function versionOf(employeeId: string): Promise<number> {
  const [row] = await getDatabase()
    .select({ version: employees.version })
    .from(employees)
    .where(eq(employees.id, employeeId));

  return row!.version;
}

/**
 * Gives each demo employee the demo availability, through the Scheduling service a manager
 * would use. An employee who already has any recurring availability (from an earlier run or
 * edited by hand) is left alone, so reruns add nothing and manual edits survive.
 */
async function seedDemoAvailability(actor: Actor): Promise<{ employees: number; windows: number }> {
  const database = getDatabase();
  const demoEmployees = await database
    .select({ id: employees.id, hireDate: employees.hireDate })
    .from(employees)
    .where(like(employees.employeeNumber, "DEMO-%"));
  const configured = new Set(
    (
      await database
        .select({ employeeId: employeeAvailability.employeeId })
        .from(employeeAvailability)
        .innerJoin(employees, eq(employees.id, employeeAvailability.employeeId))
        .where(like(employees.employeeNumber, "DEMO-%"))
    ).map((row) => row.employeeId),
  );
  let added = 0;
  let windows = 0;

  for (const employee of demoEmployees) {
    if (configured.has(employee.id)) {
      continue;
    }

    for (const dayOfWeek of DEMO_AVAILABILITY.daysOfWeek) {
      await addRecurringAvailability(
        database,
        actor,
        { kind: "employee", employeeId: employee.id },
        {
          dayOfWeek,
          startTime: DEMO_AVAILABILITY.startTime,
          endTime: DEMO_AVAILABILITY.endTime,
          availabilityType: "AVAILABLE",
          effectiveFrom: employee.hireDate,
          effectiveTo: null,
          thisLocationOnly: false,
        },
      );
      windows += 1;
    }

    added += 1;
  }

  return { employees: added, windows };
}

/** Phase 21 demo guests (added in Phase 22, policy 24). */
const DEMO_PROFILES: readonly DemoProfile[] = [
  {
    displayName: "Demo Guest Peanut",
    vip: true,
    vipReason: "Regular",
    preferences: "Window table",
    allergies: [{ allergen: "PEANUTS", severity: "SEVERE" }],
  },
  {
    displayName: "Demo Guest Milk",
    vip: false,
    vipReason: null,
    preferences: null,
    allergies: [{ allergen: "MILK", severity: "ALLERGY" }],
  },
];

async function main(): Promise<void> {
  loadLocalEnv();
  assertLocalDevelopment("Demo data");

  const database = getDatabase();

  try {
    const actor = await mainOwnerActor("employees.create");
    const positionRows = await database
      .select({ id: positions.id, code: positions.code })
      .from(positions)
      .where(eq(positions.organizationId, actor.organizationId));
    const positionIds = new Map(positionRows.map((row) => [row.code, row.id]));
    let addedPositions = 0;

    for (const position of DEMO_POSITIONS) {
      if (!positionIds.has(position.code)) {
        const created = await createPosition(database, actor, position);

        positionIds.set(position.code, created.id);
        addedPositions += 1;
      }
    }

    const existing = new Set(
      (
        await database
          .select({ employeeNumber: employees.employeeNumber })
          .from(employees)
          .where(like(employees.employeeNumber, "DEMO-%"))
      ).map((row) => row.employeeNumber),
    );
    let created = 0;

    for (const demo of DEMO_EMPLOYEES) {
      if (existing.has(demo.employeeNumber)) {
        continue;
      }

      const positionId = positionIds.get(demo.position.code);

      if (!positionId) {
        throw new Error(`Position ${demo.position.code} does not exist.`);
      }

      const employee = await createEmployee(database, actor, {
        employeeNumber: demo.employeeNumber,
        firstName: demo.firstName,
        middleName: null,
        lastName: demo.lastName,
        preferredName: demo.preferredName ?? null,
        workEmail: `${demo.firstName}.${demo.lastName}`
          .normalize("NFD")
          .replace(/[^\w.]/g, "")
          .toLowerCase()
          .concat("@demo.example.test"),
        hireDate: demo.hireDate,
        employmentType: demo.employmentType,
        positionId,
      });

      await updatePersonalContact(database, actor, employee.id, {
        personalEmail: null,
        phone: demo.phone,
        expectedVersion: employee.version,
      });

      const wage = (code: string, effectiveFrom: string, pay: typeof demo.position.wage) =>
        changeCompensation(database, actor, {
          employeeId: employee.id,
          positionId: positionIds.get(code)!,
          compensationType: pay.type,
          hourlyRate: pay.type === "HOURLY" ? pay.hourlyRate : null,
          annualSalary: pay.type === "SALARY" ? pay.annualSalary : null,
          effectiveFrom,
          changeReason: "Demo data",
        });

      await wage(demo.position.code, demo.hireDate, demo.position.wage);

      if (demo.secondary) {
        await assignPosition(database, actor, actor, {
          employeeId: employee.id,
          positionId: positionIds.get(demo.secondary.code)!,
          primaryPosition: false,
          effectiveFrom: demo.secondary.effectiveFrom,
          expectedVersion: await versionOf(employee.id),
        });
        await wage(
          demo.secondary.code,
          demo.secondary.effectiveFrom,
          demo.secondary.wage,
        );
      }

      created += 1;
    }

    console.log(
      `Demo data: ${created} employees added, ${DEMO_EMPLOYEES.length - created} already present, ${addedPositions} positions added.`,
    );

    const availability = await seedDemoAvailability(actor);

    console.log(
      `Demo availability: ${availability.employees} employees given ${DEMO_AVAILABILITY.startTime}-${DEMO_AVAILABILITY.endTime} every day (${availability.windows} windows); employees with availability already were left alone.`,
    );

    const kitchen = await seedDemoKitchen(database, actor);

    console.log(
      `Demo kitchen: ${kitchen.inventoryItems} inventory items, ${kitchen.supplierItems} supplier items, ${kitchen.orders} purchase orders, ${kitchen.menuItems} menu items, ${kitchen.recipes} recipes, ${kitchen.modifiers} modifiers added.`,
    );

    // Phase 21 data (added in Phase 22): allergen tags and guest profiles, skipped where present.
    const allergenActor = await mainOwnerActor("recipes.allergens.manage");
    const tagged = await seedIngredientAllergens(database, allergenActor);
    const declared = await seedDeclaredAllergens(database, allergenActor);
    const profiles = await seedGuestProfiles(database, await mainOwnerActor("guests.manage"), DEMO_PROFILES);

    console.log(
      `Demo guests and allergens: ${tagged} ingredients tagged, ${declared} declared allergen(s), ${profiles} guest profiles added; existing ones were left alone.`,
    );
  } finally {
    await closeDatabase();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Demo seeding failed.");
  process.exitCode = 1;
});
