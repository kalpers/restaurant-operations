import type { AssignmentRationale } from "@/modules/scheduling/rules/explanation-builder";

/** "Why this assignment": the stored hard checks and score reasons, for reviewers. */
export function AssignmentExplanation({ rationale }: { rationale: AssignmentRationale }) {
  return (
    <details className="mt-1 text-sm">
      <summary className="cursor-pointer underline">Why this assignment</summary>
      <ul className="mt-1 grid gap-1 pl-2">
        {rationale.checks.map((check) => (
          <li key={check.code}>
            {check.passed ? "✓" : "✗"} {check.label}
          </li>
        ))}
      </ul>
      <p className="mt-2 font-medium">Score {rationale.score}</p>
      {rationale.reasons.length === 0 ? (
        <p className="text-neutral-600">No scoring adjustments applied.</p>
      ) : (
        <ul className="grid gap-1 pl-2">
          {rationale.reasons.map((reason) => (
            <li key={`${reason.code}-${reason.detail}`}>
              {reason.points > 0 ? `+${reason.points}` : reason.points}{" "}
              {reason.detail}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
