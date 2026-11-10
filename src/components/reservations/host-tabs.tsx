import Link from "next/link";

export type HostTabsProps = {
  active: "floor" | "reservations" | "waitlist";
  abilities: { floor: boolean; reservations: boolean; waitlist: boolean };
};

const TABS = [
  { key: "floor", href: "/restaurant/floor", label: "Floor" },
  { key: "reservations", href: "/host/reservations", label: "Reservations" },
  { key: "waitlist", href: "/host/waitlist", label: "Waitlist" },
] as const;

/** Moves among the host's three views. Usability only: each page checks its own permission. */
export function HostTabs({ active, abilities }: HostTabsProps) {
  return (
    <nav aria-label="Host views" className="mb-4 flex gap-2">
      {TABS.filter((tab) => abilities[tab.key]).map((tab) => (
        <Link
          key={tab.key}
          href={tab.href}
          aria-current={tab.key === active ? "page" : undefined}
          className={`flex min-h-11 items-center rounded border px-4 text-sm font-medium ${
            tab.key === active
              ? "border-brand-700 bg-brand-700 text-white"
              : "border-neutral-400"
          }`}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
