import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { PermissionCode } from "@/modules/auth/permission-catalog";
import { ROLE_CATALOG } from "@/modules/auth/role-catalog";

const WRITE_PERMISSIONS: readonly PermissionCode[] = [
  "menu.edit",
  "menu.pricing.view",
  "menu.pricing.edit",
  "menu.modifiers.manage",
  "prep-stations.manage",
  "recipes.view",
  "recipes.edit",
];

const grantsOf = (code: string) =>
  ROLE_CATALOG.find((role) => role.code === code)?.permissions ?? [];

describe("menu and recipe role matrix", () => {
  it("gives Owner, General Manager and Manager every menu and recipe permission", () => {
    for (const code of ["OWNER", "GENERAL_MANAGER", "MANAGER"]) {
      for (const permission of ["menu.view", ...WRITE_PERMISSIONS]) {
        expect(grantsOf(code)).toContain(permission);
      }
    }
  });

  it("lets floor and kitchen roles view the menu but never edit prices, modifiers or recipes", () => {
    for (const code of ["SERVER", "BARTENDER", "HOST", "COOK", "WAIT_STAFF", "INVENTORY_MANAGER"]) {
      const grants = grantsOf(code);

      expect(grants.filter((permission) => WRITE_PERMISSIONS.includes(permission))).toEqual([]);
    }

    for (const code of ["SERVER", "BARTENDER", "COOK", "WAIT_STAFF"]) {
      expect(grantsOf(code)).toContain("menu.view");
    }
  });
});

describe("menu module boundaries", () => {
  function sourceFiles(directory: string): string[] {
    return readdirSync(directory).flatMap((entry) => {
      const full = path.join(directory, entry);

      return statSync(full).isDirectory()
        ? sourceFiles(full)
        : full.endsWith(".ts") && !full.endsWith(".test.ts")
          ? [full]
          : [];
    });
  }

  const files = [...sourceFiles("src/modules/menu"), ...sourceFiles("src/modules/recipes")];

  it("reads no restricted HR table, security role table or guest data", () => {
    for (const file of files) {
      const text = readFileSync(file, "utf8");

      for (const forbidden of [
        "employeePositionCompensation",
        "employeeAddresses",
        "employeeEmergencyContacts",
        "employeeDisciplinaryActions",
        "employeeNotes",
        "employeeDocuments",
        "userRoles",
        "rolePermissions",
        "guestParties",
        "reservations",
      ]) {
        expect(`${file}: ${text.includes(forbidden)}`).toBe(`${file}: false`);
      }
    }
  });

  it("reaches Inventory only through its read door, and no other domain at all", () => {
    for (const file of files) {
      // The one allowed Inventory import: item identity and unit convertibility, read-only.
      const text = readFileSync(file, "utf8").replaceAll("modules/inventory/queries/item-facts", "");

      expect(`${file}: ${/modules\/(inventory|orders|kitchen|restaurant|reservations|employees|scheduling)/.test(text)}`).toBe(
        `${file}: false`,
      );
    }
  });

  it("keeps Recipes independent of Menu", () => {
    for (const file of sourceFiles("src/modules/recipes")) {
      expect(`${file}: ${readFileSync(file, "utf8").includes("modules/menu")}`).toBe(`${file}: false`);
    }
  });

  it("checks authorization inside every exported service", () => {
    const services = files.filter((file) => file.includes(`${path.sep}services${path.sep}`));

    for (const file of services.filter((entry) => !entry.endsWith("access.ts"))) {
      const text = readFileSync(file, "utf8");
      const exported = (text.match(/export async function \w+/g) ?? []).length;
      const checks = (text.match(/assert(Any)?Permission\(/g) ?? []).length;

      // Internal resolvers (price, revision, selection loading) document that callers check.
      // Phase 23: the location setup copies run inside the open-location workflow, which checks.
      const internal = (text.match(/export async function (resolve\w+|loadSelectionGroups|loadUnitRules|listIngredients|copyPrepStationsAndRouting|copyMenusOffered|copyLocationPrices|copyTaxRates)/g) ?? []).length;

      expect(`${file}: ${checks >= exported - internal}`).toBe(`${file}: true`);
    }
  });
});
