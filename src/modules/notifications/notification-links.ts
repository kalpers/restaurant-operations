// Phase 20 (policy 12): where each notification kind leads, in one map. The target depends
// on what the recipient may open: a manager's overtime notice opens the time clock, an
// employee's opens My time.

export type NotificationLink = { href: string; label: string };

export function notificationLink(
  type: string,
  row: { orderId: string | null },
  permissions: ReadonlySet<string>,
): NotificationLink | null {
  switch (type) {
    case "FOOD_READY":
    case "BAR_ORDER_READY":
      return row.orderId ? { href: `/orders/${row.orderId}`, label: "Open order" } : null;
    case "INVENTORY_LOW":
      return { href: "/inventory/low-stock", label: "See low stock" };
    case "LOT_EXPIRING":
      return { href: "/inventory/lots", label: "See lots" };
    case "SCHEDULE_PUBLISHED":
    case "SHIFT_CHANGED":
    case "TIME_OFF_APPROVED":
    case "TIME_OFF_DENIED":
      return { href: "/my-schedule", label: "Open my schedule" };
    case "CERTIFICATION_EXPIRING":
      return permissions.has("hr.certifications.view") ? { href: "/employees", label: "Open employees" } : null;
    case "OVERTIME_APPROACHING":
    case "MISSED_CLOCK_OUT":
      return permissions.has("timeclock.view")
        ? { href: "/scheduling/time-clock", label: "Open the time clock" }
        : { href: "/my-time", label: "Open my time" };
    default:
      return null;
  }
}
