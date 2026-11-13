import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { PermissionCode } from "@/modules/auth/permission-catalog";
import { ROLE_CATALOG } from "@/modules/auth/role-catalog";

const INVENTORY_CODES: readonly PermissionCode[] = [
  "inventory.view",
  "inventory.receive",
  "inventory.adjust",
  "inventory.count",
  "inventory.count.approve",
  "inventory.waste",
  "inventory.transfer",
  "inventory.configure",
  "inventory.cost.view",
  "purchasing.view",
  "purchasing.manage",
  "purchasing.submit",
  "suppliers.manage",
];

const grantsOf = (code: string) => ROLE_CATALOG.find((role) => role.code === code)?.permissions ?? [];

describe("inventory and purchasing role matrix", () => {
  it("gives managers and the Inventory Manager every inventory and purchasing code", () => {
    for (const role of ["OWNER", "GENERAL_MANAGER", "MANAGER", "INVENTORY_MANAGER"]) {
      expect(grantsOf(role)).toEqual(expect.arrayContaining([...INVENTORY_CODES]));
    }
  });

  it("lets a Cook see stock and record waste, and nothing else", () => {
    expect(grantsOf("COOK").filter((code) => INVENTORY_CODES.includes(code)).sort()).toEqual([
      "inventory.view",
      "inventory.waste",
    ]);
  });

  it("gives floor roles no inventory or purchasing access", () => {
    for (const role of ["SERVER", "BARTENDER", "HOST", "WAIT_STAFF"]) {
      expect(grantsOf(role).filter((code) => INVENTORY_CODES.includes(code))).toEqual([]);
    }
  });
});

describe("inventory module boundaries", () => {
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

  const files = sourceFiles("src/modules/inventory");

  it("reads no HR, guest or security-role data", () => {
    for (const file of files) {
      const text = readFileSync(file, "utf8");

      for (const forbidden of [
        "employeePositionCompensation",
        "employeeAddresses",
        "employeeNotes",
        "guestParties",
        "reservations",
        "userRoles",
        "rolePermissions",
      ]) {
        expect(`${file}: ${text.includes(forbidden)}`).toBe(`${file}: false`);
      }
    }
  });

  it("depends on no menu, recipe, order or kitchen module", () => {
    for (const file of files) {
      expect(`${file}: ${/modules\/(menu|recipes|orders|kitchen|restaurant|reservations|employees|scheduling)/.test(readFileSync(file, "utf8"))}`).toBe(
        `${file}: false`,
      );
    }
  });

  it("writes stock only through the posting service", () => {
    for (const file of files.filter((entry) => !entry.endsWith("posting-service.ts"))) {
      const text = readFileSync(file, "utf8");

      expect(`${file}: ${/\.insert\(inventoryTransactions\)|\.update\(inventoryBalances\)|\.insert\(inventoryBalances\)/.test(text)}`).toBe(
        `${file}: false`,
      );
    }
  });

  // Phase 23 (policy 17): lots move only with a posting (lot-posting.ts, called by the posting
  // service). The lot service creates the opening lot and corrects a code or expiry, never a
  // remaining quantity.
  it("moves lots only through the posting service", () => {
    for (const file of files.filter((entry) => !/(lot-posting|lot-service)\.ts$/.test(entry))) {
      const text = readFileSync(file, "utf8");

      expect(`${file}: ${/\.insert\(inventoryLots\)|\.update\(inventoryLots\)|\.insert\(inventoryLotMovements\)/.test(text)}`).toBe(
        `${file}: false`,
      );
    }

    const lotService = readFileSync(files.find((entry) => entry.endsWith("lot-service.ts"))!, "utf8");
    const updates = lotService.match(/\.update\(inventoryLots\)[\s\S]*?\.where\(/g) ?? [];

    expect(updates.length).toBeGreaterThan(0);
    expect(updates.some((update) => update.includes("quantityRemaining"))).toBe(false);
  });

  it("checks a permission in every exported service operation", () => {
    for (const file of files.filter((entry) => entry.includes(`${path.sep}services${path.sep}`) && !entry.endsWith("access.ts"))) {
      const text = readFileSync(file, "utf8");
      const exported = (text.match(/export (async )?function \w+/g) ?? []).length;
      const checks = (text.match(/assert(Any)?Permission\(/g) ?? []).length;
      // Called inside an authorized caller's transaction, by design.
      const internal = (
        text.match(/export (async )?function (postInventoryTransaction|lockBalance|latestSequence|readPostingSettings|postConsumption|postOrderConsumption|postRemakeConsumption|postSaleReversal|requireSupplier|receivedByLine|lockOrder|bumpOrder|applyStockAlert|copyStockedItems|findOpenInventoryWork|formatTransferNumber|formatLotNumber|createLot|postLotMovements|findLotsNeedingWarning)\b/g) ?? []
      ).length;

      expect(`${file}: ${checks >= exported - internal}`).toBe(`${file}: true`);
    }
  });
});
