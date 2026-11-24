import { describe, expect, it } from "vitest";

import { AppError } from "@/shared/errors/app-error";

import {
  assertCanComplete,
  assertCanSignOff,
  assertRunWorkable,
  canChangeTick,
  canWorkRun,
  datesDescending,
  displayStatus,
  isTemplateRelevant,
  skipReasonOf,
} from "./checklist-rules";

const codeOf = (work: () => unknown) => {
  try {
    work();
  } catch (error) {
    return (error as AppError).code;
  }

  return undefined;
};

describe("checklist rules (Phase 36 policy 5)", () => {
  it("completes only when no required item is open", () => {
    expect(codeOf(() => assertCanComplete([{ required: true, state: "OPEN" }]))).toBe("CHECKLIST_INCOMPLETE");
    expect(codeOf(() => assertCanComplete([{ required: false, state: "OPEN" }, { required: true, state: "SKIPPED" }]))).toBeUndefined();
    expect(codeOf(() => assertCanComplete([{ required: true, state: "DONE" }]))).toBeUndefined();
  });

  it("works a run only on its own business date while open", () => {
    expect(codeOf(() => assertRunWorkable({ status: "OPEN", businessDate: "2026-11-23" }, "2026-11-23"))).toBeUndefined();
    expect(codeOf(() => assertRunWorkable({ status: "OPEN", businessDate: "2026-11-22" }, "2026-11-23"))).toBe("CHECKLIST_READ_ONLY");
    expect(codeOf(() => assertRunWorkable({ status: "COMPLETED", businessDate: "2026-11-23" }, "2026-11-23"))).toBe("CHECKLIST_COMPLETED");
  });

  it("needs a skip reason of 1 to 200 characters", () => {
    expect(skipReasonOf("  Out of stock  ")).toBe("Out of stock");
    expect(codeOf(() => skipReasonOf(""))).toBe("SKIP_REASON_REQUIRED");
    expect(codeOf(() => skipReasonOf("x".repeat(201)))).toBe("SKIP_REASON_REQUIRED");
  });

  it("lets the ticker or a manager change a tick, and anyone tick an open item", () => {
    expect(canChangeTick({ state: "OPEN", actedByUserId: null }, "u2", false)).toBe(true);
    expect(canChangeTick({ state: "DONE", actedByUserId: "u1" }, "u1", false)).toBe(true);
    expect(canChangeTick({ state: "DONE", actedByUserId: "u1" }, "u2", false)).toBe(false);
    expect(canChangeTick({ state: "SKIPPED", actedByUserId: "u1" }, "u2", true)).toBe(true);
  });

  it("keeps side work to its owner and managers", () => {
    expect(canWorkRun({ kind: "OPENING", employeeId: null }, null, false)).toBe(true);
    expect(canWorkRun({ kind: "SIDE_WORK", employeeId: "e1" }, "e1", false)).toBe(true);
    expect(canWorkRun({ kind: "SIDE_WORK", employeeId: "e1" }, "e2", false)).toBe(false);
    expect(canWorkRun({ kind: "SIDE_WORK", employeeId: "e1" }, null, false)).toBe(false);
    expect(canWorkRun({ kind: "SIDE_WORK", employeeId: "e1" }, null, true)).toBe(true);
  });

  it("signs off once, a completed run that needs it, by someone else", () => {
    const run = { status: "COMPLETED" as const, requiresSignOff: true, signedOffAt: null, completedByUserId: "u1" };

    expect(codeOf(() => assertCanSignOff(run, "u2"))).toBeUndefined();
    expect(codeOf(() => assertCanSignOff(run, "u1"))).toBe("SIGN_OFF_BY_ANOTHER");
    expect(codeOf(() => assertCanSignOff({ ...run, requiresSignOff: false }, "u2"))).toBe("SIGN_OFF_NOT_REQUIRED");
    expect(codeOf(() => assertCanSignOff({ ...run, status: "OPEN" }, "u2"))).toBe("CHECKLIST_NOT_COMPLETED");
    expect(codeOf(() => assertCanSignOff({ ...run, signedOffAt: new Date() }, "u2"))).toBe("ALREADY_SIGNED_OFF");
  });

  it("works out the status on read", () => {
    const run = { status: "OPEN" as const, requiresSignOff: false, signedOffAt: null, businessDate: "2026-11-23" };

    expect(displayStatus(null, "2026-11-23")).toBe("NOT_STARTED");
    expect(displayStatus(run, "2026-11-23")).toBe("IN_PROGRESS");
    expect(displayStatus({ ...run, businessDate: "2026-11-22" }, "2026-11-23")).toBe("NOT_COMPLETED");
    expect(displayStatus({ ...run, status: "COMPLETED" }, "2026-11-23")).toBe("COMPLETED");
    expect(displayStatus({ ...run, status: "COMPLETED", requiresSignOff: true }, "2026-11-23")).toBe("AWAITING_SIGN_OFF");
    expect(displayStatus({ ...run, status: "COMPLETED", requiresSignOff: true, signedOffAt: new Date() }, "2026-11-23")).toBe("SIGNED_OFF");
  });

  it("treats a template for no positions as everyone's", () => {
    expect(isTemplateRelevant([], new Set())).toBe(true);
    expect(isTemplateRelevant(["p1"], new Set(["p2"]))).toBe(false);
    expect(isTemplateRelevant(["p1", "p2"], new Set(["p2"]))).toBe(true);
  });

  it("lists dates newest first", () => {
    expect(datesDescending("2026-02-27", "2026-03-01")).toEqual(["2026-03-01", "2026-02-28", "2026-02-27"]);
  });
});
