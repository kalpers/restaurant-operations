import { employeeReferenceDataSeed } from "./employee-reference-data";
import {
  inventoryDemoCatalogSeed,
  packagingUnitsSeed,
  securityInventoryPermissionsSeed,
} from "./inventory-foundation";
import {
  menuInitialConfigurationSeed,
  securityMenuPermissionsSeed,
  unitsOfMeasureSeed,
} from "./menu-foundation";
import { securityKitchenPermissionsSeed } from "./kitchen-foundation";
import { securityOrdersPermissionsSeed } from "./orders-foundation";
import { securitySettlementPermissionsSeed } from "./settlement-foundation";
import { organizationFoundationSeed } from "./organization-foundation";
import {
  restaurantInitialFloorSeed,
  securityRestaurantPermissionsSeed,
} from "./restaurant-foundation";
import { securityReservationsPermissionsSeed } from "./reservations-foundation";
import type { Seed } from "./run-seeds";
import {
  schedulingDefaultRulesSeed,
  securitySchedulingPermissionsSeed,
} from "./scheduling-foundation";
import { securityFoundationSeed } from "./security-foundation";
import { securityHrPermissionsSeed } from "./security-hr-permissions";
import { securitySystemPermissionsSeed } from "./security-system-permissions";
import { securityChecksCloseoutPermissionsSeed } from "./checks-closeout-permissions";
import { securityLaborTipsPermissionsSeed } from "./labor-tips-permissions";

/** Seeds run in this order. Later phases register their seeds here. */
export const seeds: readonly Seed[] = [
  organizationFoundationSeed,
  securityFoundationSeed,
  securityHrPermissionsSeed,
  employeeReferenceDataSeed,
  securitySchedulingPermissionsSeed,
  schedulingDefaultRulesSeed,
  securityRestaurantPermissionsSeed,
  restaurantInitialFloorSeed,
  securityReservationsPermissionsSeed,
  securityMenuPermissionsSeed,
  unitsOfMeasureSeed,
  menuInitialConfigurationSeed,
  securityInventoryPermissionsSeed,
  packagingUnitsSeed,
  inventoryDemoCatalogSeed,
  securityOrdersPermissionsSeed,
  securityKitchenPermissionsSeed,
  securitySettlementPermissionsSeed,
  securitySystemPermissionsSeed,
  securityChecksCloseoutPermissionsSeed,
  securityLaborTipsPermissionsSeed,
];
