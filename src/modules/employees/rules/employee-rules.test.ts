import { describe, expect, it } from "vitest";

import { BusinessRuleError, ValidationError } from "@/shared/errors/app-error";

import {
  assertCertificationDates,
  assertCompensationAmounts,
  assertEffectiveRange,
  assertEndDateAllowed,
  assertStatusChangeAllowed,
  assertTerminationDateAllowed,
  calendarDateIn,
  isValidMoney,
  noteRequiresSensitiveAccess,
  previousDay,
} from "./employee-rules";

describe("effective dates", () => {
  it("accepts a one-day period and an open end", () => {
    expect(() => assertEffectiveRange("2026-01-01", "2026-01-01")).not.toThrow();
    expect(() => assertEffectiveRange("2026-01-01", null)).not.toThrow();
  });

  it("rejects a start after the end", () => {
    expect(() => assertEffectiveRange("2026-01-02", "2026-01-01")).toThrow(
      ValidationError,
    );
  });

  it("finds the previous day across months, years and leap days", () => {
    expect(previousDay("2026-03-01")).toBe("2026-02-28");
    expect(previousDay("2028-03-01")).toBe("2028-02-29");
    expect(previousDay("2026-01-01")).toBe("2025-12-31");
  });

  it("isn't shifted by a daylight-saving change", () => {
    expect(previousDay("2026-03-09")).toBe("2026-03-08");
    expect(previousDay("2026-11-02")).toBe("2026-11-01");
  });

  it("reads the calendar date at the location, not in UTC", () => {
    const instant = new Date("2026-06-15T02:00:00.000Z");

    expect(calendarDateIn("America/Detroit", instant)).toBe("2026-06-14");
    expect(calendarDateIn("UTC", instant)).toBe("2026-06-15");
  });
});

describe("ending a row", () => {
  const today = "2026-06-15";

  it("allows today and the past, but not the future", () => {
    expect(() =>
      assertEndDateAllowed({ from: "2026-01-01", to: today, today }),
    ).not.toThrow();
    expect(() =>
      assertEndDateAllowed({ from: "2026-01-01", to: "2026-06-16", today }),
    ).toThrow(BusinessRuleError);
  });

  it("allows closing a row that hasn't started on its own start date", () => {
    expect(() =>
      assertEndDateAllowed({ from: "2026-07-01", to: "2026-07-01", today }),
    ).not.toThrow();
  });

  it("rejects an end before the start", () => {
    expect(() =>
      assertEndDateAllowed({ from: "2026-02-01", to: "2026-01-31", today }),
    ).toThrow(ValidationError);
  });
});

describe("termination date", () => {
  const dates = { hireDate: "2026-01-10", today: "2026-06-15" };

  it("must fall between the hire date and today", () => {
    expect(() =>
      assertTerminationDateAllowed({ ...dates, terminationDate: "2026-01-10" }),
    ).not.toThrow();
    expect(() =>
      assertTerminationDateAllowed({ ...dates, terminationDate: "2026-01-09" }),
    ).toThrow(BusinessRuleError);
    expect(() =>
      assertTerminationDateAllowed({ ...dates, terminationDate: "2026-06-16" }),
    ).toThrow(BusinessRuleError);
  });
});

describe("status changes", () => {
  it("moves between the working statuses", () => {
    expect(() => assertStatusChangeAllowed("ACTIVE", "ON_LEAVE")).not.toThrow();
    expect(() => assertStatusChangeAllowed("ON_LEAVE", "ACTIVE")).not.toThrow();
    expect(() => assertStatusChangeAllowed("ACTIVE", "SUSPENDED")).not.toThrow();
  });

  it("keeps TERMINATED final and out of the ordinary path", () => {
    expect(() => assertStatusChangeAllowed("TERMINATED", "ACTIVE")).toThrow(
      expect.objectContaining({ code: "EMPLOYEE_TERMINATED" }),
    );
    expect(() => assertStatusChangeAllowed("ACTIVE", "TERMINATED")).toThrow(
      expect.objectContaining({ code: "USE_TERMINATION_WORKFLOW" }),
    );
  });

  it("rejects a change to the same status", () => {
    expect(() => assertStatusChangeAllowed("ACTIVE", "ACTIVE")).toThrow(
      expect.objectContaining({ code: "STATUS_UNCHANGED" }),
    );
  });
});

describe("compensation amounts", () => {
  it.each(["0", "9.5", "9.50", "1234567890.12"])("accepts %s", (value) => {
    expect(isValidMoney(value)).toBe(true);
  });

  it.each(["-1", "1.005", "12345678901", "1e3", "abc", "", "1.", ".5"])(
    "rejects %s",
    (value) => {
      expect(isValidMoney(value)).toBe(false);
    },
  );

  it("requires exactly the field that matches the type", () => {
    expect(() =>
      assertCompensationAmounts({
        compensationType: "HOURLY",
        hourlyRate: "9.50",
        annualSalary: null,
      }),
    ).not.toThrow();
    expect(() =>
      assertCompensationAmounts({
        compensationType: "SALARY",
        hourlyRate: null,
        annualSalary: "52000.00",
      }),
    ).not.toThrow();
  });

  it.each([
    { compensationType: "HOURLY", hourlyRate: null, annualSalary: null },
    { compensationType: "HOURLY", hourlyRate: "9.50", annualSalary: "1.00" },
    { compensationType: "SALARY", hourlyRate: "9.50", annualSalary: null },
    { compensationType: "SALARY", hourlyRate: "9.50", annualSalary: "1.00" },
    { compensationType: "HOURLY", hourlyRate: "1.005", annualSalary: null },
  ] as const)("rejects %o", (input) => {
    expect(() => assertCompensationAmounts(input)).toThrow(ValidationError);
  });
});

describe("note sensitivity", () => {
  it("treats manager and performance notes as sensitive whatever the flag says", () => {
    expect(
      noteRequiresSensitiveAccess({ noteType: "MANAGER", sensitive: false }),
    ).toBe(true);
    expect(
      noteRequiresSensitiveAccess({ noteType: "PERFORMANCE", sensitive: false }),
    ).toBe(true);
  });

  it("honors the flag on other types", () => {
    expect(
      noteRequiresSensitiveAccess({ noteType: "GENERAL", sensitive: true }),
    ).toBe(true);
    expect(
      noteRequiresSensitiveAccess({ noteType: "GENERAL", sensitive: false }),
    ).toBe(false);
  });
});

describe("certification dates", () => {
  it("requires an expiration date when the type does", () => {
    expect(() =>
      assertCertificationDates({
        expirationRequired: true,
        issuedDate: "2026-01-01",
        expirationDate: null,
      }),
    ).toThrow(BusinessRuleError);
    expect(() =>
      assertCertificationDates({
        expirationRequired: false,
        issuedDate: "2026-01-01",
        expirationDate: null,
      }),
    ).not.toThrow();
  });

  it("rejects an issue date after the expiration date", () => {
    expect(() =>
      assertCertificationDates({
        expirationRequired: true,
        issuedDate: "2026-02-01",
        expirationDate: "2026-01-01",
      }),
    ).toThrow(ValidationError);
  });
});
