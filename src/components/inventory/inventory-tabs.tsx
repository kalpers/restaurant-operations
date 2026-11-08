import Link from "next/link";

import type { PermissionCode } from "@/modules/auth/permission-catalog";

const TABS: readonly { href: string; label: string; permission: PermissionCode }[] = [
  { href: "/inventory", label: "On hand", permission: "inventory.view" },
  { href: "/inventory/low-stock", label: "Low stock", permission: "inventory.view" },
  { href: "/inventory/transactions", label: "Transactions", permission: "inventory.view" },
  { href: "/inventory/movements", label: "Waste, adjustments and transfers", permission: "inventory.view" },
  { href: "/inventory/counts", label: "Counts", permission: "inventory.count" },
  { href: "/inventory/items", label: "Items", permission: "inventory.configure" },
];

/** Usability only: every page and API checks its own permission. */
export function InventoryTabs({
  current,
  permissions,
}: {
  current: string;
  permissions: readonly string[];
}) {
  return (
    <nav aria-label="Inventory" className="mb-6 flex flex-wrap gap-2">
      {TABS.filter((tab) => permissions.includes(tab.permission)).map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          aria-current={tab.href === current ? "page" : undefined}
          className={`inline-flex min-h-11 items-center rounded border px-3 text-sm font-medium ${
            tab.href === current ? "border-neutral-900 bg-neutral-900 text-white" : "border-neutral-400"
          }`}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
