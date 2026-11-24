import { ALL_PERMISSION_CODES, type PermissionCode } from "./permission-catalog";

/**
 * Identifies the Owner role for its data invariants (immutable, at least one active
 * holder). Authorization decisions never use it: they check permissions.
 */
export const OWNER_ROLE_CODE = "OWNER";

export type RoleDefinition = {
  code: string;
  name: string;
  description: string;
  permissions: readonly PermissionCode[];
};

const GENERAL_MANAGER_EXCLUDED: readonly PermissionCode[] = [
  "admin.roles.manage",
  "organization.manage",
  "hr.compensation.edit",
];

/** What anyone on staff can do for themselves in Scheduling. */
const SCHEDULE_SELF_SERVICE: readonly PermissionCode[] = [
  "schedule.view",
  "schedule.availability.self",
  "schedule.time-off.request",
  "schedule.swap.request",
  // Phase 18: clock in and out, own entries, own tip shares.
  "timeclock.punch",
];

/** Phase 32 (policy 11): everyone on staff reads the day's pre-shift notes. */
const STAFF_BRIEFING: readonly PermissionCode[] = ["pre-shift.view"];

/** Phase 36 (policy 2): everyone on the floor or the line works through checklists. */
const STAFF_CHECKLISTS: readonly PermissionCode[] = ["checklists.view", "checklists.complete"];

/** Phase 36 (policy 2): reading and recording food-safety temperatures. */
const FOOD_SAFETY_RECORDING: readonly PermissionCode[] = ["food-safety.view", "food-safety.record"];

/** Clearing up after a party, which floor staff do during service. */
const SESSION_CLOSE_OUT: readonly PermissionCode[] = [
  "restaurant.complete-session",
  "restaurant.clean-table",
];

/** Working a station's queue. Station type scope comes from `kitchen.manage` / `bar.manage`. */
const FULFILLMENT_ACTIONS: readonly PermissionCode[] = [
  "fulfillment.start",
  "fulfillment.ready",
  "fulfillment.complete",
  "fulfillment.remake",
];

const SERVER_PERMISSIONS: readonly PermissionCode[] = [
  "restaurant.view",
  ...SESSION_CLOSE_OUT,
  "menu.view",
  "orders.view",
  "orders.create",
  "orders.edit",
  "orders.submit",
  ...SCHEDULE_SELF_SERVICE,
  ...STAFF_BRIEFING,
  "settlements.view",
  "settlements.create",
  "settlements.tender.cash",
  "settlements.tender.external-card",
  "settlements.tender.gift-card",
  "settlements.complete",
  // Phase 17: split checks, fire held courses, choose a drawer for cash.
  "orders.move-items",
  "orders.fire",
  "drawers.view",
  // Read-only Expo and station context, to see when food and drinks are ready.
  "kitchen.view",
  "bar.view",
  // Phase 21: look up the guest at the table.
  "guests.view",
  // Phase 30: redeem the guest's loyalty reward on the check.
  "loyalty.redeem",
  // Phase 31: look up, sell and reload gift cards.
  "gift-cards.view",
  "gift-cards.sell",
  // Phase 36: checklists and the event sheet.
  ...STAFF_CHECKLISTS,
  "events.view",
];

/** The starting role-permission matrix. Later changes use a new versioned seed. */
export const ROLE_CATALOG: readonly RoleDefinition[] = [
  {
    code: OWNER_ROLE_CODE,
    name: "Owner",
    description: "Every application permission.",
    permissions: ALL_PERMISSION_CODES,
  },
  {
    code: "GENERAL_MANAGER",
    name: "General Manager",
    description:
      "Runs the restaurant, without role definitions, organization settings or compensation edits.",
    permissions: ALL_PERMISSION_CODES.filter(
      (code) => !GENERAL_MANAGER_EXCLUDED.includes(code),
    ),
  },
  {
    code: "MANAGER",
    name: "Manager",
    description:
      "Day-to-day operations and management-level HR records, without restricted HR or security administration.",
    permissions: [
      "admin.users.view",
      "organization.view",
      "locations.view",
      "employees.view",
      "hr.view",
      "hr.certifications.view",
      "hr.certifications.manage",
      "hr.performance.view",
      "hr.performance.manage",
      "hr.notes.view",
      "hr.notes.manage",
      "schedule.view",
      "schedule.edit",
      "schedule.generate",
      "schedule.publish",
      "schedule.availability.self",
      "schedule.availability.manage",
      "schedule.time-off.request",
      "schedule.time-off.approve",
      "schedule.swap.request",
      "schedule.swap.approve",
      "schedule.templates.manage",
      "schedule.rules.manage",
      "restaurant.view",
      "restaurant.tables.manage",
      "restaurant.sections.manage",
      "restaurant.seat",
      "restaurant.move",
      "restaurant.complete-session",
      "restaurant.cancel-session",
      "restaurant.clean-table",
      "restaurant.condition.manage",
      "restaurant.server.assign",
      "restaurant.capacity.override",
      "restaurant.schedule.override",
      "reservations.view",
      "reservations.manage",
      "reservations.override-hold",
      "waitlist.view",
      "waitlist.manage",
      "waitlist.notify",
      "waitlist.seat",
      // Phase 21: guest profiles and allergen labels.
      "guests.view",
      "guests.contact.view",
      "guests.manage",
      "guests.merge",
      "recipes.allergens.manage",
      // Phase 30: guest loyalty.
      "loyalty.redeem",
      "loyalty.adjust",
      "loyalty.manage",
      // Phase 22: online booking and guest messages.
      "reservations.online.manage",
      "messages.view",
      "messages.resend",
      "menu.view",
      "menu.edit",
      "menu.pricing.view",
      "menu.pricing.edit",
      "menu.modifiers.manage",
      // Phase 19: 86 and restore items at the location.
      "menu.availability.manage",
      "prep-stations.manage",
      "recipes.view",
      "recipes.edit",
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
      "orders.view",
      "orders.create",
      "orders.edit",
      "orders.submit",
      "orders.void",
      "orders.close",
      "orders.discount.apply",
      "orders.discount.manage",
      "settlements.view",
      "settlements.create",
      "settlements.tender.cash",
      "settlements.tender.external-card",
      "settlements.tender.gift-card",
      "settlements.tender.house-account",
      "settlements.tender.other",
      "settlements.complete",
      "settlements.void-tender",
      "settlements.view-card-metadata",
      "orders.move-items",
      "orders.fire",
      "settlements.refund",
      "settlements.refund-void",
      // Phase 31: gift cards.
      "gift-cards.view",
      "gift-cards.sell",
      "gift-cards.manage",
      // Phase 32: the manager log (not redaction) and pre-shift notes.
      "manager-log.view",
      "manager-log.write",
      "pre-shift.view",
      "pre-shift.manage",
      // Phase 36: checklists, temperature logs, events, invoice entry (not approval).
      "checklists.view",
      "checklists.complete",
      "checklists.manage",
      "food-safety.view",
      "food-safety.record",
      "food-safety.manage",
      "events.view",
      "events.manage",
      "purchasing.invoices.record",
      "drawers.view",
      "drawers.operate",
      "tax.view",
      // Phase 20: tax-exempt checks.
      "tax.exempt",
      "kitchen.view",
      "kitchen.manage",
      "bar.view",
      "bar.manage",
      ...FULFILLMENT_ACTIONS,
      "reports.view",
      "reports.sales",
      "reports.orders",
      "reports.inventory",
      "reports.fulfillment",
      "reports.settlements",
      "reports.seating",
      // Phase 18: time clock oversight, tip pools and the Tips report.
      "timeclock.punch",
      "timeclock.view",
      "timeclock.manage",
      "tips.manage",
      "reports.tips",
    ],
  },
  {
    code: "SERVER",
    name: "Server",
    description: "Takes and settles orders for guests.",
    permissions: SERVER_PERMISSIONS,
  },
  {
    code: "BARTENDER",
    name: "Bartender",
    description: "Takes orders and fulfills bar tickets.",
    permissions: [
      ...SERVER_PERMISSIONS,
      "bar.manage",
      ...FULFILLMENT_ACTIONS,
      // Phase 19: the bar 86es drinks it has run out of.
      "menu.availability.manage",
      // Phase 36: bar coolers and ice wells.
      "food-safety.record",
    ],
  },
  {
    code: "HOST",
    name: "Host",
    description: "Manages seating, reservations and the waitlist.",
    permissions: [
      "restaurant.view",
      "restaurant.seat",
      "restaurant.move",
      "restaurant.server.assign",
      ...SESSION_CLOSE_OUT,
      "reservations.view",
      "reservations.manage",
      "waitlist.view",
      "waitlist.manage",
      "waitlist.notify",
      "waitlist.seat",
      // Phase 21: guest profiles at the host stand.
      "guests.view",
      "guests.contact.view",
      "guests.manage",
      // Phase 22: guest message history and resend.
      "messages.view",
      "messages.resend",
      // Phase 31: tell a guest what is left on their gift card.
      "gift-cards.view",
      ...SCHEDULE_SELF_SERVICE,
      ...STAFF_BRIEFING,
      // Phase 36: checklists and events at the host stand.
      ...STAFF_CHECKLISTS,
      "events.view",
    ],
  },
  {
    code: "COOK",
    name: "Cook",
    description: "Fulfills kitchen tickets.",
    permissions: [
      "kitchen.view",
      "kitchen.manage",
      ...FULFILLMENT_ACTIONS,
      "menu.view",
      // Phase 19: the kitchen 86es dishes it has run out of.
      "menu.availability.manage",
      "inventory.view",
      "inventory.waste",
      ...SCHEDULE_SELF_SERVICE,
      ...STAFF_BRIEFING,
      // Phase 36: line checklists and temperature readings.
      ...STAFF_CHECKLISTS,
      ...FOOD_SAFETY_RECORDING,
    ],
  },
  {
    code: "WAIT_STAFF",
    name: "Wait Staff",
    description: "Support staff who run food and clear tables, without order entry.",
    permissions: [
      "restaurant.view",
      "restaurant.clean-table",
      "menu.view",
      "kitchen.view",
      "bar.view",
      // Phase 21: see a guest's allergies when running food.
      "guests.view",
      ...SCHEDULE_SELF_SERVICE,
      ...STAFF_BRIEFING,
      // Phase 36: side work and event sheets.
      ...STAFF_CHECKLISTS,
      "events.view",
    ],
  },
  {
    code: "INVENTORY_MANAGER",
    name: "Inventory Manager",
    description: "Receives, adjusts and counts inventory.",
    permissions: [
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
      "menu.view",
      // Phase 21: tag ingredients with their allergens.
      "recipes.allergens.manage",
      // Phase 36: enter supplier invoices, read receiving temperatures.
      "purchasing.invoices.record",
      "food-safety.view",
      ...SCHEDULE_SELF_SERVICE,
      ...STAFF_BRIEFING,
      "reports.view",
      "reports.inventory",
    ],
  },
];
