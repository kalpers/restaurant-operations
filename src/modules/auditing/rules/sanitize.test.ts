import { describe, expect, it } from "vitest";

import { AUDIT_ACTIONS } from "../audit-actions";
import { changedFieldNames, isForbiddenField, sanitizeAuditPayload } from "./sanitize";

describe("audit payload allow-list", () => {
  it("keeps only listed fields", () => {
    expect(sanitizeAuditPayload({ status: "OPEN", passwordHash: "x", note: "free text" }, ["status"])).toEqual({
      status: "OPEN",
    });
  });

  it("returns null when nothing survives", () => {
    expect(sanitizeAuditPayload({ other: 1 }, ["status"])).toBeNull();
    expect(sanitizeAuditPayload(null, ["status"])).toBeNull();
  });

  it("never records nested objects, which could carry unlisted fields", () => {
    expect(sanitizeAuditPayload({ status: { secret: "x" } }, ["status"])).toBeNull();
  });

  it("records string arrays, dates as ISO text and decimal strings unchanged", () => {
    expect(
      sanitizeAuditPayload(
        { added: ["orders.view"], effectiveFrom: new Date("2026-11-09T12:00:00Z"), amount: "12.50" },
        ["added", "effectiveFrom", "amount"],
      ),
    ).toEqual({ added: ["orders.view"], effectiveFrom: "2026-11-09T12:00:00.000Z", amount: "12.50" });
  });

  it("records a changedOnly field as whether it changed, never its value", () => {
    const before = { rate: "18.00", payType: "HOURLY" };
    const after = { rate: "19.25", payType: "HOURLY" };

    expect(sanitizeAuditPayload(after, ["rate", "payType"], ["rate"], before)).toEqual({ rate: true, payType: "HOURLY" });
    expect(sanitizeAuditPayload(after, ["rate"], ["rate"], after)).toEqual({ rate: false });
    expect(sanitizeAuditPayload(after, ["rate"], ["rate"])).toEqual({ rate: true });
  });

  it("names changed fields without their values", () => {
    expect(
      changedFieldNames({ phone: "555-0100", city: "A" }, { phone: "555-0199", city: "A" }, ["phone", "city"]),
    ).toEqual(["phone"]);
  });
});

describe("audit registry", () => {
  it("lets no action record a sensitive field except as a changed marker", () => {
    for (const [action, definition] of Object.entries(AUDIT_ACTIONS)) {
      const changedOnly: readonly string[] = "changedOnly" in definition ? definition.changedOnly : [];

      for (const field of definition.fields) {
        if (changedOnly.includes(field)) {
          continue;
        }

        expect(isForbiddenField(field), `${action}.${field}`).toBe(false);
      }
    }
  });

  it("recognises sensitive words in camelCase field names", () => {
    expect(isForbiddenField("passwordHash")).toBe(true);
    expect(isForbiddenField("hourlyRate")).toBe(true);
    expect(isForbiddenField("cardNumber")).toBe(true);
    expect(isForbiddenField("homeAddress")).toBe(true);
    expect(isForbiddenField("status")).toBe(false);
    expect(isForbiddenField("effectiveDate")).toBe(false);
  });

  it("names every action domain.action-name, as the table requires", () => {
    for (const action of Object.keys(AUDIT_ACTIONS)) {
      expect(action).toMatch(/^[a-z]+[.][a-z-]+$/);
    }
  });
});
