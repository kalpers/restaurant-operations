import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { positions, preShiftNotes } from "@/db/schema";
import type { Actor } from "@/modules/auth/types";
import { readLocationClock } from "@/modules/restaurant/services/access";
import {
  createNote,
  listNotesForManager,
  listNotesForReader,
  updateNote,
  withdrawNote,
  type NoteInput,
} from "@/modules/restaurant/services/pre-shift-service";
import { AppError } from "@/shared/errors/app-error";
import { addDays } from "@/shared/time/zoned-time";

import { actorWith, clearEmployeeData, createPositionFixture } from "../../fixtures/employee-fixtures";
import { createLinkedEmployee, createSchedulingScenario, type SchedulingScenario } from "../../fixtures/scheduling-fixtures";

const database = () => getDatabase();

async function codeOf(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppError) {
      return error.code;
    }

    return (error as Error).message;
  }

  return undefined;
}

describe("pre-shift notes (Phase 32)", () => {
  let scenario: SchedulingScenario;
  let manager: Actor;
  let server: Actor;
  let cook: Actor;
  let cookPosition: string;
  let today: string;

  beforeEach(async () => {
    scenario = await createSchedulingScenario(database());
    manager = await actorWith(database(), scenario, ["pre-shift.view", "pre-shift.manage"]);
    cookPosition = await createPositionFixture(database(), scenario.organizationId, `COOK_${Date.now()}`);
    ({ actor: server } = await createLinkedEmployee(database(), scenario, ["pre-shift.view"], { positionId: scenario.server }));
    ({ actor: cook } = await createLinkedEmployee(database(), scenario, ["pre-shift.view"], { positionId: cookPosition }));
    today = (await readLocationClock(database(), scenario.locationA, new Date())).businessDate;
  });

  afterAll(async () => {
    await clearEmployeeData(database());
    await closeDatabase();
  });

  function note(input: Partial<NoteInput> = {}) {
    return createNote(database(), manager, {
      businessDate: today,
      title: "Tonight",
      body: "Halibut special; out of the rosé.",
      pinned: false,
      positionIds: [],
      ...input,
    });
  }

  const titles = async (actor: Actor) => (await listNotesForReader(database(), actor)).notes.map((entry) => entry.title);

  it("shows everyone notes and the reader's own positions, pinned first", async () => {
    await note({ title: "Everyone" });
    await note({ title: "Servers", positionIds: [scenario.server] });
    await note({ title: "Cooks", positionIds: [cookPosition] });
    await note({ title: "Pinned", pinned: true });
    await note({ title: "Tomorrow", businessDate: addDays(today, 1) });

    expect(await titles(server)).toEqual(["Pinned", "Everyone", "Servers"]);
    expect(await titles(cook)).toEqual(["Pinned", "Everyone", "Cooks"]);
    expect(await titles(manager)).toEqual(["Pinned", "Everyone", "Servers", "Cooks"]);

    const servers = (await listNotesForReader(database(), server)).notes.find((entry) => entry.title === "Servers")!;

    expect(servers.positions).toEqual([{ id: scenario.server, name: expect.any(String) }]);
  });

  it("doesn't count a position held at another location", async () => {
    const atB = await actorWith(database(), scenario, ["pre-shift.view"], scenario.locationB);

    await note({ title: "Servers", positionIds: [scenario.server] });

    expect(await titles(atB)).toEqual([]);
  });

  it("accepts today through 14 days ahead only", async () => {
    expect(await codeOf(note({ businessDate: addDays(today, 14) }))).toBeUndefined();
    expect(await codeOf(note({ businessDate: addDays(today, 15) }))).toBe("NOTE_DATE_TOO_FAR");
    expect(await codeOf(note({ businessDate: addDays(today, -1) }))).toBe("NOTE_DATE_PASSED");
  });

  it("edits with optimistic concurrency and replaces the positions", async () => {
    const created = await note({ positionIds: [cookPosition] });
    const edited = await updateNote(database(), manager, created.id, {
      businessDate: today,
      title: "Tonight (updated)",
      body: "Halibut sold out; swordfish instead.",
      pinned: true,
      positionIds: [scenario.server],
      expectedVersion: created.version,
    });

    expect(edited).toMatchObject({ title: "Tonight (updated)", pinned: true, version: created.version + 1 });
    expect(edited.positions.map((position) => position.id)).toEqual([scenario.server]);
    expect(await titles(server)).toEqual(["Tonight (updated)"]);
    expect(await titles(cook)).toEqual([]);

    expect(
      await codeOf(
        updateNote(database(), manager, created.id, {
          businessDate: today,
          title: "Stale",
          body: "x",
          pinned: false,
          positionIds: [],
          expectedVersion: created.version,
        }),
      ),
    ).toBe("CONCURRENCY_CONFLICT");
  });

  it("withdraws a note, which readers stop seeing and managers still list", async () => {
    const created = await note();
    const withdrawn = await withdrawNote(database(), manager, created.id, { expectedVersion: created.version });

    expect(withdrawn).toMatchObject({ active: false, editable: false });
    expect(await titles(server)).toEqual([]);
    expect((await listNotesForManager(database(), manager, { from: today, to: today })).notes).toHaveLength(1);
    expect(await codeOf(withdrawNote(database(), manager, created.id, { expectedVersion: withdrawn.version }))).toBe(
      "NOTE_WITHDRAWN",
    );
  });

  it("is read only once its date has passed", async () => {
    const created = await note();

    // Move it into the past, as if the day had ended.
    await database().update(preShiftNotes).set({ businessDate: addDays(today, -1) }).where(eq(preShiftNotes.id, created.id));

    expect(await codeOf(withdrawNote(database(), manager, created.id, { expectedVersion: created.version }))).toBe("NOTE_READ_ONLY");
    expect(
      await codeOf(
        updateNote(database(), manager, created.id, {
          businessDate: today,
          title: "Late",
          body: "x",
          pinned: false,
          positionIds: [],
          expectedVersion: created.version,
        }),
      ),
    ).toBe("NOTE_READ_ONLY");

    const [listed] = (await listNotesForManager(database(), manager, { from: addDays(today, -1), to: today })).notes;

    expect(listed!.editable).toBe(false);
  });

  it("refuses positions of another organization and newly chosen inactive ones", async () => {
    const other = await createSchedulingScenario(database());

    expect(await codeOf(note({ positionIds: [other.server] }))).toBe("NOT_FOUND");

    await database().update(positions).set({ active: false }).where(eq(positions.id, cookPosition));

    expect(await codeOf(note({ positionIds: [cookPosition] }))).toBe("POSITION_INACTIVE");
  });

  it("enforces each permission", async () => {
    const nobody = await actorWith(database(), scenario, ["schedule.view"]);
    const created = await note();

    expect(await codeOf(listNotesForReader(database(), nobody))).toBe("PERMISSION_DENIED");
    expect(await codeOf(createNote(database(), server, { businessDate: today, title: "x", body: "x", pinned: false, positionIds: [] }))).toBe(
      "PERMISSION_DENIED",
    );
    expect(await codeOf(withdrawNote(database(), server, created.id, { expectedVersion: 1 }))).toBe("PERMISSION_DENIED");
    expect(await codeOf(listNotesForManager(database(), server, { from: today, to: today }))).toBe("PERMISSION_DENIED");
  });
});
