import type { getPeriodCoverage } from "@/modules/scheduling/services/coverage-service";

export type CoverageData = Awaited<ReturnType<typeof getPeriodCoverage>>;

function CoverageTable({
  title,
  lines,
}: {
  title: string;
  lines: CoverageData["byDay"];
}) {
  if (lines.length === 0) {
    return null;
  }

  return (
    <div className="overflow-x-auto">
      <h3 className="mb-1 font-medium">{title}</h3>
      <table className="w-full border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-neutral-300">
            <th className="px-2 py-1 font-semibold">{title.replace("By ", "")}</th>
            <th className="px-2 py-1 font-semibold">Needed</th>
            <th className="px-2 py-1 font-semibold">Filled</th>
            <th className="px-2 py-1 font-semibold">Open</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={line.key} className="border-b border-neutral-200">
              <td className="px-2 py-1">{line.label}</td>
              <td className="px-2 py-1">{line.required}</td>
              <td className="px-2 py-1">{line.filled}</td>
              <td className="px-2 py-1">{line.open}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function CoverageSection({ coverage }: { coverage: CoverageData }) {
  return (
    <section
      aria-labelledby="coverage-heading"
      className="mb-8 rounded border border-neutral-200 p-4"
    >
      <h2 id="coverage-heading" className="mb-2 font-semibold">
        Coverage
      </h2>
      <p className="mb-3" data-testid="coverage-summary">
        {coverage.filled} of {coverage.required} slots filled, {coverage.open} open
      </p>

      {coverage.hardViolations.length > 0 && (
        <div className="mb-3 rounded border border-red-300 bg-red-50 p-3">
          <h3 className="mb-1 font-medium text-red-800">Must be fixed</h3>
          <ul className="grid gap-1 text-sm text-red-800">
            {coverage.hardViolations.map((violation) => (
              <li key={violation.assignmentId}>
                {violation.employeeName}, {violation.shiftDate},{" "}
                {violation.positionName}: {violation.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {coverage.warnings.length > 0 && (
        <div className="mb-3 rounded border border-amber-300 bg-amber-50 p-3">
          <h3 className="mb-1 font-medium text-amber-900">Warnings</h3>
          <ul className="grid gap-1 text-sm text-amber-900">
            {coverage.warnings.map((warning, index) => (
              <li key={`${warning.code}-${warning.shiftId ?? ""}-${index}`}>
                {warning.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-3">
        <CoverageTable title="By day" lines={coverage.byDay} />
        <CoverageTable title="By position" lines={coverage.byPosition} />
        <CoverageTable title="By area" lines={coverage.byArea} />
      </div>
    </section>
  );
}
