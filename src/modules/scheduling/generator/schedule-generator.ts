import {
  compareCandidates,
  fairnessCountsFor,
  scoreCandidate,
  softWarningsFor,
  type FairnessCounts,
} from "../rules/candidate-scorer";
import {
  evaluateEligibility,
  type EligibilityShift,
  type EmployeeFacts,
  type EmployeeScheduleContext,
  type HardConstraintCode,
} from "../rules/eligibility";
import {
  buildUnfilledDetail,
  type AssignmentRationale,
  type UnfilledShiftDetail,
} from "../rules/explanation-builder";
import type { SchedulingRuleSet } from "../rules/schedule-rules";

export type GeneratorShift = EligibilityShift & {
  periodId: string;
  priority: number;
  requiredEmployeeCount: number;
  assignedEmployeeIds: readonly string[];
};

export type GeneratorInput = {
  periodId: string;
  timeZone: string;
  rules: SchedulingRuleSet;
  shifts: readonly GeneratorShift[];
  employees: readonly EmployeeFacts[];
  contexts: ReadonlyMap<string, EmployeeScheduleContext>;
};

export type ProposedAssignment = {
  shiftId: string;
  employeeId: string;
  rationale: AssignmentRationale;
};

export type ProposalWarning = {
  code: string;
  message: string;
  shiftId: string;
  employeeId: string;
};

export type ScheduleProposal = {
  assignments: ProposedAssignment[];
  unfilled: UnfilledShiftDetail[];
  warnings: ProposalWarning[];
};

function compareShifts(left: GeneratorShift, right: GeneratorShift): number {
  return (
    right.priority - left.priority ||
    Number(left.startAt) - Number(right.startAt) ||
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  );
}

/**
 * Fills open slots. Pure and deterministic: identical input gives identical output, with
 * no clock, randomness or database access. Existing assignments are read, never changed.
 * Eligibility is the same evaluator manual assignment uses.
 */
export function generate(input: GeneratorInput): ScheduleProposal {
  const { rules, timeZone, periodId } = input;
  const contexts = new Map(input.contexts);
  const proposal: ScheduleProposal = {
    assignments: [],
    unfilled: [],
    warnings: [],
  };

  for (const shift of [...input.shifts].sort(compareShifts)) {
    const onShift = new Set(shift.assignedEmployeeIds);
    let openSlots = shift.requiredEmployeeCount - onShift.size;
    let rejections: HardConstraintCode[][] = [];

    while (openSlots > 0) {
      const eligible: {
        employee: EmployeeFacts;
        context: EmployeeScheduleContext;
        checks: AssignmentRationale["checks"];
        counts: FairnessCounts;
      }[] = [];

      rejections = [];

      for (const employee of input.employees) {
        const context = contexts.get(employee.id);

        if (!context || onShift.has(employee.id)) {
          continue;
        }

        const result = evaluateEligibility({
          shift,
          employee,
          context,
          rules,
          timeZone,
        });

        if (result.eligible) {
          eligible.push({
            employee,
            context,
            checks: result.checks,
            counts: fairnessCountsFor(context, periodId, timeZone),
          });
        } else {
          rejections.push(result.violations);
        }
      }

      if (eligible.length === 0) {
        break;
      }

      const highestCounts: FairnessCounts = {
        weekend: Math.max(...eligible.map(({ counts }) => counts.weekend)),
        closing: Math.max(...eligible.map(({ counts }) => counts.closing)),
      };
      const [best] = eligible
        .map((candidate) => ({
          ...candidate,
          ...scoreCandidate({
            shift,
            employee: candidate.employee,
            context: candidate.context,
            rules,
            timeZone,
            counts: candidate.counts,
            highestCounts,
          }),
        }))
        .sort(compareCandidates);

      if (!best) {
        break;
      }

      for (const warning of softWarningsFor({
        shift,
        context: best.context,
        rules,
      })) {
        proposal.warnings.push({
          ...warning,
          shiftId: shift.id,
          employeeId: best.employee.id,
        });
      }

      proposal.assignments.push({
        shiftId: shift.id,
        employeeId: best.employee.id,
        rationale: {
          checks: best.checks,
          score: best.score,
          reasons: best.reasons,
        },
      });
      contexts.set(best.employee.id, {
        ...best.context,
        assignments: [
          ...best.context.assignments,
          {
            shiftId: shift.id,
            periodId: shift.periodId,
            shiftDate: shift.shiftDate,
            startAt: shift.startAt,
            endAt: shift.endAt,
          },
        ],
      });
      onShift.add(best.employee.id);
      openSlots -= 1;
    }

    if (openSlots > 0) {
      proposal.unfilled.push(
        buildUnfilledDetail({ shiftId: shift.id, openSlots, rejections }),
      );
    }
  }

  return proposal;
}
