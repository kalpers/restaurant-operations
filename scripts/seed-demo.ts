import { and, eq, like } from "drizzle-orm";

import { loadLocalEnv, readExplicitNodeEnv } from "../src/config/tooling-env";
import { closeDatabase, getDatabase } from "../src/db";
import {
  DEMO_EMPLOYEES,
  DEMO_POSITIONS,
} from "../src/db/demo/demo-employees";
import {
  employees,
  locations,
  positions,
  roles,
  userRoles,
} from "../src/db/schema";
import {
  getUserAuthContext,
  requirePermission,
} from "../src/modules/auth/services/permission-service";
import type { Actor } from "../src/modules/auth/types";
import { assignPosition } from "../src/modules/employees/services/assignment-service";
import { changeCompensation } from "../src/modules/employees/services/compensation-service";
import { createEmployee } from "../src/modules/employees/services/employee-service";
import { updatePersonalContact } from "../src/modules/employees/services/personal-service";
import { createPosition } from "../src/modules/employees/services/reference-service";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Adds data, never removes it, but demo people don't belong in a shared database. */
function assertLocalDevelopment(): void {
  const url = process.env.DATABASE_URL ?? "";
  let host = "";

  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    // An unreadable URL is refused below.
  }

  if (readExplicitNodeEnv() === "production" || !LOOPBACK.has(host)) {
    throw new Error(
      "Demo data is for a local development database only: use a loopback DATABASE_URL and a non-production NODE_ENV.",
    );
  }
}

async function ownerActor(): Promise<Actor> {
  const database = getDatabase();
  const [location] = await database
    .select({ id: locations.id })
    .from(locations)
    .where(eq(locations.locationCode, "MAIN"));
  const [owner] = await database
    .select({ userId: userRoles.userId })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(
      and(eq(roles.code, "OWNER"), eq(userRoles.locationId, location!.id)),
    );

  if (!location || !owner) {
    throw new Error(
      "No Owner exists at MAIN. Run `npm run bootstrap:owner` first, then run this again.",
    );
  }

  const context = await getUserAuthContext(database, owner.userId);

  return requirePermission(context!, {
    permission: "employees.create",
    locationId: location.id,
  });
}

async function versionOf(employeeId: string): Promise<number> {
  const [row] = await getDatabase()
    .select({ version: employees.version })
    .from(employees)
    .where(eq(employees.id, employeeId));

  return row!.version;
}

async function main(): Promise<void> {
  loadLocalEnv();
  assertLocalDevelopment();

  const database = getDatabase();

  try {
    const actor = await ownerActor();
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
  } finally {
    await closeDatabase();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Demo seeding failed.");
  process.exitCode = 1;
});
