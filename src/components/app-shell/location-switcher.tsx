"use client";

import { useRouter } from "next/navigation";

import { sendApiRequest } from "@/components/forms/api-request";
import { useToast } from "@/components/ui/toast";

type LocationSwitcherProps = {
  currentLocationId: string;
  locations: { id: string; name: string }[];
};

export function LocationSwitcher({
  currentLocationId,
  locations,
}: LocationSwitcherProps) {
  const router = useRouter();
  const toast = useToast();

  async function handleChange(locationId: string) {
    const result = await sendApiRequest("PUT", "/api/session/location", {
      locationId,
    });

    if (result.ok) {
      router.refresh();
    } else {
      toast.error(result.message);
    }
  }

  // Phase 23: the current location is always named; the picker appears with two or more.
  if (locations.length < 2) {
    return (
      <span className="flex items-center gap-2 text-sm font-medium" data-testid="current-location">
        {locations.find((location) => location.id === currentLocationId)?.name}
      </span>
    );
  }

  return (
    <label className="flex items-center gap-2 text-sm font-medium">
      Location
      <select
        value={currentLocationId}
        onChange={(event) => void handleChange(event.target.value)}
        className="min-h-11 rounded-md border border-neutral-300 bg-white px-2 shadow-sm"
      >
        {locations.map((location) => (
          <option key={location.id} value={location.id}>
            {location.name}
          </option>
        ))}
      </select>
    </label>
  );
}
