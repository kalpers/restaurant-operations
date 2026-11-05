import Link from "next/link";

import { requirePageUser } from "@/modules/auth/guards";

export default async function AccessDeniedPage() {
  await requirePageUser();

  return (
    <>
      <h1 className="mb-2 text-2xl font-semibold">Access denied</h1>
      <p className="mb-4 text-neutral-700">
        You do not have permission to view that page at this location.
      </p>
      <Link href="/dashboard" className="underline">
        Back to the dashboard
      </Link>
    </>
  );
}
