import { requirePageUser, resolveCurrentLocation } from "@/modules/auth/guards";

export default async function DashboardPage() {
  const auth = await requirePageUser();
  const location = await resolveCurrentLocation(auth);

  return (
    <>
      <h1 className="mb-4 text-2xl font-semibold">Dashboard</h1>
      {location ? (
        <dl className="grid gap-3 sm:grid-cols-2">
          <div className="rounded border border-neutral-200 p-4">
            <dt className="text-sm text-neutral-600">Location</dt>
            <dd className="text-lg font-medium">{location.locationName}</dd>
          </div>
          <div className="rounded border border-neutral-200 p-4">
            <dt className="text-sm text-neutral-600">Your roles here</dt>
            <dd className="text-lg font-medium">
              {location.roles.map((role) => role.name).join(", ")}
            </dd>
          </div>
        </dl>
      ) : (
        <p className="text-neutral-700">
          Your account has no role at any location yet. Ask an administrator to
          assign one.
        </p>
      )}
    </>
  );
}
