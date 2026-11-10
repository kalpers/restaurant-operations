"use client";

import { Menu, UtensilsCrossed, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { ConnectionBadge } from "@/components/realtime/realtime-provider";
import { cn } from "@/components/ui/cn";
import { ToastProvider } from "@/components/ui/toast";

import { NAV_ICONS } from "./nav-icons";
import { activeHref, type NavigationGroup } from "./navigation";
import { SignOutButton } from "./sign-out-button";

type AppShellProps = {
  groups: NavigationGroup[];
  email: string;
  /** Server-chosen header controls, e.g. the location switcher and notifications. */
  headerActions: ReactNode;
  children: ReactNode;
};

/** Pages that need every pixel of width: boards and timelines. */
const FULL_WIDTH_PREFIXES = ["/restaurant/floor", "/kitchen", "/bar", "/expo", "/scheduling/timeline"];

function isFullWidth(pathname: string): boolean {
  return FULL_WIDTH_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/**
 * The signed-in frame. One <nav aria-label="Main">: a sidebar from the `lg` breakpoint up,
 * an off-canvas drawer below it. Which links appear is decided on the server by
 * permission, and that is usability only; every page and API checks again.
 */
export function AppShell({ groups, email, headerActions, children }: AppShellProps) {
  const pathname = usePathname();
  // The drawer is open only on the page it was opened from, so navigating closes it.
  const [openedOn, setOpenedOn] = useState<string | null>(null);
  const drawerOpen = openedOn === pathname;
  const setDrawerOpen = (open: boolean) => setOpenedOn(open ? pathname : null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const drawer = useRef<HTMLElement>(null);
  const current = activeHref(pathname, groups.flatMap((group) => group.items));

  const focusMenuOnClose = useRef(false);

  const closeDrawer = useCallback((returnFocus: boolean) => {
    // The page behind the drawer is inert until this render commits, so focus moves after it.
    focusMenuOnClose.current = returnFocus;
    setOpenedOn(null);
  }, []);

  useEffect(() => {
    if (!drawerOpen) {
      if (focusMenuOnClose.current) {
        focusMenuOnClose.current = false;
        menuButton.current?.focus();
      }

      return;
    }

    drawer.current?.querySelector<HTMLElement>("a, button")?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeDrawer(true);
      }
    };
    // The drawer only exists below `lg`; widening the window closes it.
    const wide = window.matchMedia("(min-width: 64rem)");
    const onWide = () => wide.matches && closeDrawer(false);

    document.addEventListener("keydown", onKey);
    wide.addEventListener("change", onWide);

    return () => {
      document.removeEventListener("keydown", onKey);
      wide.removeEventListener("change", onWide);
    };
  }, [drawerOpen, closeDrawer]);

  return (
    <ToastProvider>
      <div className="min-h-screen lg:grid lg:grid-cols-[16rem_1fr]">
        {drawerOpen && (
          <div aria-hidden className="fixed inset-0 z-30 bg-neutral-900/40 lg:hidden" onClick={() => closeDrawer(true)} />
        )}
        <aside
          ref={drawer}
          id="main-navigation"
          className={cn(
            "fixed inset-y-0 left-0 z-40 flex w-72 max-w-[85vw] flex-col border-r border-neutral-200 bg-surface transition-transform",
            "lg:sticky lg:top-0 lg:z-auto lg:h-screen lg:w-auto lg:max-w-none lg:translate-x-0",
            drawerOpen ? "translate-x-0" : "max-lg:invisible -translate-x-full",
          )}
        >
          <div className="flex min-h-14 items-center justify-between gap-2 border-b border-neutral-200 px-4">
            <Link href="/dashboard" className="flex items-center gap-2 font-semibold text-brand-800">
              <span className="inline-flex size-8 items-center justify-center rounded-md bg-brand-700 text-white">
                <UtensilsCrossed aria-hidden className="size-4" />
              </span>
              Restaurant Operations
            </Link>
            <button
              type="button"
              onClick={() => closeDrawer(true)}
              aria-label="Close menu"
              className="inline-flex size-11 items-center justify-center rounded-md hover:bg-neutral-100 lg:hidden"
            >
              <X aria-hidden className="size-5" />
            </button>
          </div>
          <nav aria-label="Main" className="flex-1 overflow-y-auto px-2 py-3">
            {groups.map((group) => (
              <div key={group.id} className="mb-4">
                <p id={`nav-group-${group.id}`} className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-neutral-600">
                  {group.label}
                </p>
                <ul aria-labelledby={`nav-group-${group.id}`} className="grid gap-0.5">
                  {group.items.map((item) => {
                    const Icon = NAV_ICONS[item.icon];
                    const active = item.href === current;

                    return (
                      <li key={item.href}>
                        <Link
                          href={item.href}
                          aria-current={active ? "page" : undefined}
                          className={cn(
                            "flex min-h-11 items-center gap-3 rounded-md px-3 text-sm font-medium",
                            active
                              ? "bg-brand-50 text-brand-800 ring-1 ring-brand-200"
                              : "text-neutral-800 hover:bg-neutral-100",
                          )}
                        >
                          <Icon aria-hidden className={cn("size-4 shrink-0", active ? "text-brand-700" : "text-neutral-500")} />
                          {item.label}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </nav>
        </aside>

        <div inert={drawerOpen || undefined} className="flex min-w-0 flex-col">
          <header className="sticky top-0 z-20 border-b border-neutral-200 bg-surface/95 backdrop-blur">
            <div className="flex min-h-14 flex-wrap items-center gap-3 px-4 py-2">
              <button
                ref={menuButton}
                type="button"
                onClick={() => setDrawerOpen(true)}
                aria-expanded={drawerOpen}
                aria-controls="main-navigation"
                className="inline-flex min-h-11 items-center gap-2 rounded-md border border-neutral-300 px-3 text-sm font-medium lg:hidden"
              >
                <Menu aria-hidden className="size-5" />
                Menu
              </button>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                {headerActions}
                <ConnectionBadge />
                <span
                  className="hidden max-w-48 items-center gap-2 truncate text-sm text-neutral-700 md:inline-flex"
                  title={email}
                >
                  <span aria-hidden className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-brand-100 font-semibold text-brand-800">
                    {email.charAt(0).toUpperCase()}
                  </span>
                  <span className="truncate">{email}</span>
                </span>
                <SignOutButton />
              </div>
            </div>
          </header>
          <main
            className={cn("w-full px-4 py-6", isFullWidth(pathname) ? "max-w-none" : "mx-auto max-w-6xl")}
          >
            {children}
          </main>
        </div>
      </div>
    </ToastProvider>
  );
}
