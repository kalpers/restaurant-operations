/**
 * Phase 13 validation fixture data (docs/Phase-13-Validation-Seed-Data.md). Opt-in only,
 * through `npm run db:seed:validation`; it is never part of the default seed list, so no
 * shared or cloud database receives these people or this history.
 */

/** Marks a completed run in `seed_runs`. Change the fixture by adding a new key. */
export const VALIDATION_SEED_KEY = "phase13.validation-fixtures";
/** Phase 18: the validation server's time entry, the MAIN tip pool and today's distribution. */
export const VALIDATION_LABOR_SEED_KEY = "phase18.validation-labor-tips";
/** Phase 19: Buffalo Wings 86'd at MAIN, a pickle-chip low-stock alert and its suggested draft. */
export const VALIDATION_MENU_STOCK_SEED_KEY = "phase19.validation-menu-stock";
/** Phase 20: the Extra Bacon modifier 86'd at MAIN. */
export const VALIDATION_SERVICE_POLISH_SEED_KEY = "phase20.validation-service-polish";

export const VALIDATION_EMPLOYEES = [
  { employeeNumber: "P13-SERVER", firstName: "Vera", lastName: "Validation", position: "SERVER", hourlyRate: "12.00" },
  { employeeNumber: "P13-HOST", firstName: "Hal", lastName: "Validation", position: "HOST", hourlyRate: "14.00" },
  { employeeNumber: "P13-COOK", firstName: "Cora", lastName: "Validation", position: "COOK", hourlyRate: "18.00" },
  { employeeNumber: "P13-BAR", firstName: "Bo", lastName: "Validation", position: "BARTENDER", hourlyRate: "13.00" },
] as const;

/** A future week, so it never overlaps a schedule a manager is working on now. */
export const VALIDATION_PERIOD = {
  name: "Phase 13 Validation Week 2030",
  startDate: "2030-10-05",
  endDate: "2030-10-11",
  shiftDate: "2030-10-05",
  shifts: [
    { position: "SERVER", startTime: "16:00", endTime: "23:00" },
    { position: "HOST", startTime: "16:00", endTime: "22:00" },
    { position: "COOK", startTime: "15:00", endTime: "23:00" },
    { position: "BARTENDER", startTime: "17:00", endTime: "01:00" },
  ],
} as const;

/** The seeded Phase 5 dining section the validation server is assigned to. */
export const VALIDATION_SECTION = "DINING_A";

/** The completed dine-in visit and the takeout check. */
export const VALIDATION_DINER = "Phase 13 Validation Diner";
export const VALIDATION_TAKEOUT = "Phase 13 Validation Takeout";

/** The upcoming reservation left CONFIRMED for check-in and seating tests. */
export const VALIDATION_PARTY = { guestName: "Phase 13 Validation Party", partySize: 4, tableNumber: "T02", localTime: "19:00" };

/** Codes from the demo kitchen (src/db/demo/demo-kitchen.ts) the fixture sells. */
export const CANONICAL_BURGER = {
  menuItem: "BACON_CHEESEBURGER",
  selections: [
    { group: "BURGER_TEMP", modifier: "TEMP_MEDIUM" },
    { group: "BURGER_ADDONS", modifier: "NO_ONION" },
    { group: "BURGER_ADDONS", modifier: "EXTRA_PICKLES" },
    { group: "BURGER_CHEESE", modifier: "SWISS_FOR_AMERICAN" },
  ],
} as const;
