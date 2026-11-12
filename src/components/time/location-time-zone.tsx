"use client";

import { createContext, useContext, type ReactNode } from "react";

const LocationTimeZoneContext = createContext<string>("UTC");

/** Set once by the app layout from the current location (Phase 20 policy 9). */
export function LocationTimeZoneProvider({
  timeZone,
  children,
}: {
  timeZone: string;
  children: ReactNode;
}) {
  return (
    <LocationTimeZoneContext.Provider value={timeZone}>{children}</LocationTimeZoneContext.Provider>
  );
}

/** The current location's IANA time zone, for client components. */
export function useLocationTimeZone(): string {
  return useContext(LocationTimeZoneContext);
}
