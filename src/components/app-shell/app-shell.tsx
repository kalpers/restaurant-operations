"use client";

import { ChevronDown, KeyRound, Menu, UtensilsCrossed, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { ConnectionBadge } from "@/components/realtime/realtime-provider";
import { cn } from "@/components/ui/cn";
import { ToastProvider } from "@/components/ui/toast";

import { NAV_ICONS } from "./nav-icons";
import {
  activeHref,
  isNavGroupOpen,
  NAV_GROUPS_COOKIE,
  NAV_GROUPS_COOKIE_MAX_AGE_SECONDS,
  serializeNavGroupsCookie,
  setAllNavGroups,
  toggleNavGroup,
  type NavGroupMemory,
  type NavGroupState,
  type NavigationGroup,
  type NavigationGroupId,
} from "./navigation";
import { SignOutButton } from "./sign-out-button";

type AppShellProps = {
  groups: NavigationGroup[];
  email: string;
  /** Server-chosen header controls, e.g. the location switcher and notifications. */
  headerActions: ReactNode;
  /** Phase 27: the open groups remembered in the `nav_groups` cookie, read by the layout. */
  initialNavMemory?: NavGroupMemory;
  children: ReactNode;
};

/** A presentation preference only: group IDs and open/closed, never personal data. */
function writeNavGroupsCookie(memory: NavGroupMemory): void {
  const secure = window.location.protocol === "https:" ? "; Secure" : "";

  document.cookie = `${NAV_GROUPS_COOKIE}=${serializeNavGroupsCookie(memory)}; Path=/; Max-Age=${NAV_GROUPS_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax${secure}`;
}

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
export function AppShell({ groups, email, headerActions, initialNavMemory = {}, children }: AppShellProps) {
  const pathname = usePathname();
  // The drawer is open only on the page it was opened from, so navigating closes it.
  const [openedOn, setOpenedOn] = useState<string | null>(null);
  const drawerOpen = openedOn === pathname;
  const setDrawerOpen = (open: boolean) => setOpenedOn(open ? pathname : null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const drawer = useRef<HTMLElement>(null);
  const current = activeHref(pathname, groups.flatMap((group) => group.items));
  // Phase 27 (policies 6–8): the groups the person keeps open, from the cookie the layout read.
  const [navState, setNavState] = useState<NavGroupState>({ memory: initialNavMemory, currentChoice: null });
  const openGroups = Object.fromEntries(
    groups.map((group) => [
      group.id,
      isNavGroupOpen({
        groupId: group.id,
        holdsCurrent: group.items.some((item) => item.href === current),
        pathname,
        memory: navState.memory,
        currentChoice: navState.currentChoice,
      }),
    ]),
  ) as Record<NavigationGroupId, boolean>;
  const anyClosed = groups.some((group) => !openGroups[group.id]);
  const remember = (next: NavGroupState) => {
    setNavState(next);
    writeNavGroupsCookie(next.memory);
  };

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
            {groups.length > 1 && (
              <div className="mb-1 flex justify-end px-1">
                <button
                  type="button"
                  onClick={() => remember(setAllNavGroups(groups.map((group) => group.id), { open: anyClosed, pathname }))}
                  className="inline-flex min-h-11 items-center rounded-md px-3 text-xs font-medium text-brand-700 hover:bg-neutral-100"
                >
                  {anyClosed ? "Expand all" : "Collapse all"}
                </button>
              </div>
            )}
            {groups.map((group) => {
              const holdsCurrent = group.items.some((item) => item.href === current);
              const open = openGroups[group.id];

              return (
                <div key={group.id} className="mb-1">
                  <button
                    type="button"
                    id={`nav-group-${group.id}`}
                    aria-expanded={open}
                    aria-controls={`nav-group-items-${group.id}`}
                    onClick={() =>
                      remember(toggleNavGroup(navState, { groupId: group.id, holdsCurrent, pathname, open: !open }))
                    }
                    className="flex min-h-11 w-full items-center justify-between rounded-md px-3 text-xs font-semibold uppercase tracking-wide text-neutral-600 hover:bg-neutral-100"
                  >
                    <span>{group.label}</span>
                    <ChevronDown aria-hidden className={cn("size-4 transition-transform", !open && "-rotate-90")} />
                  </button>
                  <ul
                    id={`nav-group-items-${group.id}`}
                    aria-labelledby={`nav-group-${group.id}`}
                    hidden={!open}
                    className="mb-2 grid gap-0.5"
                  >
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
              );
            })}
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
                <Link
                  href="/account/password"
                  className="inline-flex min-h-11 items-center gap-2 rounded-md px-3 text-sm font-medium text-neutral-800 hover:bg-neutral-100"
                >
                  <KeyRound aria-hidden className="size-4" />
                  Change password
                </Link>
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
