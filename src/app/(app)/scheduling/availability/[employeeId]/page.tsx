import { notFound } from "next/navigation";
import { z } from "zod";

import { AvailabilityPanel } from "@/components/scheduling/availability-panel";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { getAvailability } from "@/modules/scheduling/services/availability-service";
import { NotFoundError } from "@/shared/errors/app-error";

export default async function EmployeeAvailabilityPage({
  params,
}: {
  params: Promise<{ employeeId: string }>;
}) {
  const { actor } = await requirePageActor("schedule.availability.manage");
  const parsed = z.uuid().safeParse((await params).employeeId);

  if (!parsed.success) {
    notFound();
  }

  const employeeId = parsed.data;
  const data = await getAvailability(getDatabase(), actor, {
    kind: "employee",
    employeeId,
  }).catch((error: unknown) => {
    if (error instanceof NotFoundError) {
      notFound();
    }

    throw error;
  });

  return (
    <>
      <h1 className="mb-4 text-2xl font-semibold">Employee availability</h1>
      <AvailabilityPanel
        data={data}
        baseUrl={`/api/scheduling/employees/${employeeId}`}
      />
    </>
  );
}
