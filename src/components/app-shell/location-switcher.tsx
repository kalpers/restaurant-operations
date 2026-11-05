"use client";

import { useRouter } from "next/navigation";

import { sendApiRequest } from "@/components/forms/api-request";

type LocationSwitcherProps = {
  currentLocationId: string;
  locations: { id: string; name: string }[];
};

export function LocationSwitcher({
  currentLocationId,
  locations,
}: LocationSwitcherProps) {
  const router = useRouter();

  async function handleChange(locationId: string) {
    const result = await sendApiRequest("PUT", "/api/session/location", {
      locationId,
    });

    if (result.ok) {
      router.refresh();
    }
  }

  return (
    <label className="flex items-center gap-2 text-sm">
      Location
      <select
        value={currentLocationId}
        onChange={(event) => void handleChange(event.target.value)}
        className="min-h-11 rounded border border-neutral-300 bg-white px-2"
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
