import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";

import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import type { PermissionCode } from "@/modules/auth/permission-catalog";
import { actorHolds } from "@/modules/employees/services/access";
import { getEmployeeGeneral } from "@/modules/employees/services/employee-service";
import { NotFoundError } from "@/shared/errors/app-error";

import {
  CertificationsSection,
  CompensationSection,
  DisciplinarySection,
  DocumentsSection,
  NotesSection,
  PerformanceSection,
} from "./hr-sections";
import { OverviewSection } from "./overview-section";
import { PersonalSection } from "./personal-section";
import { Breadcrumbs } from "@/components/ui/page-header";

/** Usability only: each section's service enforces its own permission on the server. */
const TABS: readonly {
  key: string;
  label: string;
  permission: PermissionCode;
}[] = [
  { key: "overview", label: "Overview", permission: "employees.view" },
  { key: "personal", label: "Personal", permission: "hr.personal.view" },
  { key: "compensation", label: "Compensation", permission: "hr.compensation.view" },
  { key: "certifications", label: "Certifications", permission: "hr.certifications.view" },
  { key: "documents", label: "Documents", permission: "hr.documents.view" },
  { key: "notes", label: "Notes", permission: "hr.notes.view" },
  { key: "performance", label: "Performance", permission: "hr.performance.view" },
  { key: "disciplinary", label: "Disciplinary", permission: "hr.disciplinary.view" },
];

export default async function EmployeeDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ employeeId: string }>;
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  const { auth, actor } = await requirePageActor("employees.view");
  const parsedId = z.uuid().safeParse((await params).employeeId);

  if (!parsedId.success) {
    notFound();
  }

  const employeeId = parsedId.data;
  const employee = await getEmployeeGeneral(
    getDatabase(),
    actor,
    employeeId,
  ).catch((error: unknown) => {
    if (error instanceof NotFoundError) {
      notFound();
    }

    throw error;
  });

  const tabs = TABS.filter((tab) => actorHolds(actor, tab.permission));
  const requested = (await searchParams).tab;
  const active =
    tabs.find((tab) => tab.key === requested)?.key ?? "overview";
  const context = { actor, employeeId };

  return (
    <>
      <Breadcrumbs items={[{ label: "Employees", href: "/employees" }, { label: `${employee.firstName} ${employee.lastName}` }]} />
      <h1 className="mb-1 text-2xl font-semibold">
        {employee.firstName} {employee.lastName}
      </h1>
      <p className="mb-4 text-neutral-600">
        Employee number {employee.employeeNumber}
      </p>

      <nav aria-label="Employee sections" className="mb-6 border-b border-neutral-200">
        <ul className="flex flex-wrap">
          {tabs.map((tab) => (
            <li key={tab.key}>
              <Link
                href={`/employees/${employeeId}?tab=${tab.key}`}
                aria-current={tab.key === active ? "page" : undefined}
                className={`flex min-h-11 items-center px-3 text-sm font-medium ${
                  tab.key === active
                    ? "border-b-2 border-neutral-900"
                    : "text-neutral-600"
                }`}
              >
                {tab.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {/* Only the active section renders, so only its data is ever loaded. */}
      {active === "overview" && (
        <OverviewSection {...context} auth={auth} employee={employee} />
      )}
      {active === "personal" && <PersonalSection {...context} />}
      {active === "compensation" && (
        <CompensationSection {...context} employee={employee} />
      )}
      {active === "certifications" && <CertificationsSection {...context} />}
      {active === "documents" && <DocumentsSection {...context} />}
      {active === "notes" && <NotesSection {...context} />}
      {active === "performance" && <PerformanceSection {...context} />}
      {active === "disciplinary" && <DisciplinarySection {...context} />}
    </>
  );
}
