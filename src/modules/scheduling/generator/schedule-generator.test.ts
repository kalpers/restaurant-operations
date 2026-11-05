import { describe, expect, it } from "vitest";

import {
  ALWAYS_AVAILABLE,
  at,
  context,
  employee,
  HOUR_MS,
  PERIOD,
  preferences,
  rules,
  scheduled,
  shift,
  TZ,
} from "../rules/test-builders";
import type { EmployeeScheduleContext } from "../rules/eligibility";
import { generate, type GeneratorInput, type GeneratorShift } from "./schedule-generator";

const WEDNESDAY = "2027-01-06";

function generatorShift(
  overrides: Partial<GeneratorShift> & { date?: string } = {},
): GeneratorShift {
  const { date, ...rest } = overrides;

  return {
    ...shift(date ?? WEDNESDAY, "17:00", "21:00"),
    periodId: PERIOD,
    priority: 0,
    requiredEmployeeCount: 1,
    assignedEmployeeIds: [],
    ...rest,
  };
}

function input(
  shifts: GeneratorShift[],
  people: { id: string; number?: string; schedule?: Partial<EmployeeScheduleContext> }[],
  rule: Parameters<typeof rules>[0] = {},
): GeneratorInput {
  return {
    periodId: PERIOD,
    timeZone: TZ,
    rules: rules({ minimumRestHours: null, ...rule }),
    shifts,
    employees: people.map((person) =>
      employee({
        id: person.id,
        employeeNumber: person.number ?? person.id,
        displayName: person.id,
      }),
    ),
    contexts: new Map(
      people.map((person) => [person.id, context(person.schedule)]),
    ),
  };
}

describe("schedule generator", () => {
  it("assigns the eligible candidate with the highest score", () => {
    const result = generate(
      input(
        [generatorShift()],
        [
          {
            id: "over-target",
            schedule: {
              preferences: preferences({ targetMs: 4 * HOUR_MS }),
              assignments: [scheduled("2027-01-04", "09:00", "14:00")],
            },
          },
          {
            id: "under-target",
            schedule: { preferences: preferences({ targetMs: 4 * HOUR_MS }) },
          },
        ],
      ),
    );

    expect(result.assignments.map((row) => row.employeeId)).toEqual(["under-target"]);
  });

  it("never picks someone with approved time off, however strong their score", () => {
    const result = generate(
      input(
        [generatorShift()],
        [
          {
            id: "a-strong",
            schedule: {
              preferences: preferences({ targetMs: 40 * HOUR_MS }),
              approvedTimeOff: [
                { startAt: at(WEDNESDAY, "00:00"), endAt: at("2027-01-07", "00:00") },
              ],
            },
          },
          { id: "b-weak" },
        ],
      ),
    );

    expect(result.assignments.map((row) => row.employeeId)).toEqual(["b-weak"]);
  });

  it("prefers the candidate who doesn't cause overtime", () => {
    const result = generate(
      input(
        [generatorShift()],
        [
          {
            id: "a-overtime",
            schedule: { assignments: [scheduled("2027-01-04", "06:00", "23:00")] },
          },
          { id: "b-fine" },
        ],
        { weeklyOvertimeThreshold: "20.00" },
      ),
    );

    expect(result.assignments.map((row) => row.employeeId)).toEqual(["b-fine"]);
    expect(result.warnings).toEqual([]);
  });

  it("uses a stable tie-break of employee number, then ID", () => {
    const people = [
      { id: "z-id", number: "E-1" },
      { id: "a-id", number: "E-2" },
    ];

    expect(
      generate(input([generatorShift()], people)).assignments[0]?.employeeId,
    ).toBe("z-id");
    expect(
      generate(input([generatorShift()], [...people].reverse())).assignments[0]
        ?.employeeId,
    ).toBe("z-id");
  });

  it("gives identical output for identical input", () => {
    const shifts = [
      generatorShift({ id: "s1" }),
      generatorShift({ id: "s2", date: "2027-01-07" }),
      generatorShift({ id: "s3", date: "2027-01-09", requiredEmployeeCount: 2 }),
    ];
    const people = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const first = generate(input(shifts, people));

    expect(generate(input(shifts, people))).toEqual(first);
    expect(generate(input([...shifts].reverse(), [...people].reverse()))).toEqual(
      first,
    );
  });

  it("fills only open slots and leaves existing assignments out of its output", () => {
    const result = generate(
      input(
        [
          generatorShift({
            id: "s1",
            requiredEmployeeCount: 2,
            assignedEmployeeIds: ["manual"],
          }),
        ],
        [
          {
            id: "manual",
            schedule: { assignments: [{ ...scheduled(WEDNESDAY, "17:00", "21:00"), shiftId: "s1" }] },
          },
          { id: "other" },
        ],
      ),
    );

    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0]).toMatchObject({ shiftId: "s1", employeeId: "other" });
  });

  it("doesn't assign one person to two overlapping shifts it just filled", () => {
    const result = generate(
      input(
        [
          generatorShift({ id: "s1" }),
          generatorShift({ id: "s2" }),
        ],
        [{ id: "only" }],
      ),
    );

    expect(result.assignments.map((row) => row.shiftId)).toEqual(["s1"]);
    expect(result.unfilled.map((row) => row.shiftId)).toEqual(["s2"]);
    expect(result.unfilled[0]?.reasons.map((reason) => reason.code)).toEqual([
      "SHIFT_OVERLAP",
    ]);
  });

  it("spreads a required count across different people", () => {
    const result = generate(
      input(
        [generatorShift({ requiredEmployeeCount: 2 })],
        [{ id: "a" }, { id: "b" }, { id: "c" }],
      ),
    );

    expect(result.assignments.map((row) => row.employeeId)).toEqual(["a", "b"]);
  });

  it("fills higher-priority shifts first", () => {
    const result = generate(
      input(
        [
          generatorShift({ id: "early-low" }),
          generatorShift({ id: "late-high", priority: 5 }),
        ],
        [{ id: "only" }],
      ),
    );

    expect(result.assignments.map((row) => row.shiftId)).toEqual(["late-high"]);
  });

  it("balances weekend shifts using its own earlier picks", () => {
    const result = generate(
      input(
        [
          generatorShift({ id: "sat", date: "2027-01-09" }),
          generatorShift({ id: "sun", date: "2027-01-10" }),
        ],
        [{ id: "a" }, { id: "b" }],
      ),
    );

    expect(result.assignments.map((row) => row.employeeId)).toEqual(["a", "b"]);
    expect(result.assignments[1]?.rationale.reasons).toContainEqual(
      expect.objectContaining({ code: "WEEKEND_FAIRNESS", points: 8 }),
    );
  });

  it("leaves a shift open and explains it when nobody qualifies", () => {
    const result = generate(
      input(
        [generatorShift({ positionId: "bartender" })],
        [{ id: "a" }, { id: "b", schedule: { recurring: [] } }],
      ),
    );

    expect(result.assignments).toEqual([]);
    expect(result.unfilled).toHaveLength(1);
    expect(result.unfilled[0]).toMatchObject({
      openSlots: 1,
      candidatesConsidered: 2,
    });
    expect(result.unfilled[0]?.reasons).toContainEqual(
      expect.objectContaining({ code: "POSITION_NOT_HELD", employeeCount: 2 }),
    );
    expect(result.unfilled[0]?.reasons).toContainEqual(
      expect.objectContaining({
        code: "AVAILABILITY_NOT_CONFIGURED",
        employeeCount: 1,
      }),
    );
  });

  it("explains a generated assignment with its actual checks and score", () => {
    const result = generate(
      input(
        [generatorShift()],
        [
          {
            id: "a",
            schedule: {
              recurring: ALWAYS_AVAILABLE,
              preferences: preferences({ targetMs: 8 * HOUR_MS }),
            },
          },
        ],
      ),
    );
    const rationale = result.assignments[0]?.rationale;

    expect(rationale?.checks.every((check) => check.passed)).toBe(true);
    expect(rationale?.checks.map((check) => check.code)).toEqual([
      "SCHEDULABLE",
      "LOCATION",
      "POSITION",
      "AVAILABILITY",
      "TIME_OFF",
      "OVERLAP",
      "LIMITS",
    ]);
    expect(rationale?.score).toBe(20);
    expect(rationale?.reasons[0]?.code).toBe("BELOW_TARGET_HOURS");
    expect(JSON.stringify(result)).not.toMatch(
      /wage|salary|compensation|address|disciplin|ACTIVE/i,
    );
  });

  it("reports pending time off as a warning without blocking", () => {
    const result = generate(
      input(
        [generatorShift()],
        [
          {
            id: "only",
            schedule: {
              pendingTimeOff: [
                { startAt: at(WEDNESDAY, "18:00"), endAt: at(WEDNESDAY, "19:00") },
              ],
            },
          },
        ],
      ),
    );

    expect(result.assignments).toHaveLength(1);
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      "PENDING_TIME_OFF",
    ]);
  });
});
