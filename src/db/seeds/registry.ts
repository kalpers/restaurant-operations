import { employeeReferenceDataSeed } from "./employee-reference-data";
import {
  menuInitialConfigurationSeed,
  securityMenuPermissionsSeed,
  unitsOfMeasureSeed,
} from "./menu-foundation";
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
];
