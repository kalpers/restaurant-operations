import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import type { Database } from "../../src/db";
import { managerLogEntries, positions, preShiftNotes } from "../../src/db/schema";
import type { Actor } from "../../src/modules/auth/types";
import { readLocationClock } from "../../src/modules/restaurant/services/access";
import { addLogEntry, type AddLogEntryInput } from "../../src/modules/restaurant/services/manager-log-service";
import { createNote } from "../../src/modules/restaurant/services/pre-shift-service";
import { addDays } from "../../src/shared/time/zoned-time";

// Phase 32 (policy 13): a few manager log entries (one correction) and pre-shift notes at
// MAIN, written through the services a manager would use. Each part runs only while MAIN has
// none of its kind, so a rerun adds nothing. Local dev DB only.

export async function seedDemoBriefings(
  database: Database,
  manager: Actor,
): Promise<{ entries: number; notes: number }> {
  let entries = 0;
  let notes = 0;
  const [existingEntry] = await database
    .select({ id: managerLogEntries.id })
    .from(managerLogEntries)
    .where(eq(managerLogEntries.locationId, manager.locationId))
    .limit(1);

  if (!existingEntry) {
    const add = async (input: Omit<AddLogEntryInput, "idempotencyKey" | "correctsEntryId"> & { correctsEntryId?: string }) => {
      entries += 1;

      return addLogEntry(database, manager, { idempotencyKey: `demo-log-${randomUUID()}`, correctsEntryId: null, ...input });
    };

    const incident = await add({
      dateChoice: "PREVIOUS",
      category: "INCIDENT",
      body: "Server slipped near the dish pit at 8:40 PM. No injury; floor mat replaced and the area marked.",
    });

    await add({
      dateChoice: "PREVIOUS",
      category: "MAINTENANCE",
      body: "Pizza oven deck two running 40 degrees cold. Walk-in cooler door also not sealing. Called the repair company; visit booked for tomorrow morning.",
    });
    await add({
      dateChoice: "PREVIOUS",
      category: "INCIDENT",
      body: "Correction: it was near the service station, not the dish pit. Everything else as written.",
      correctsEntryId: incident.id,
    });
    await add({
      dateChoice: "CURRENT",
      category: "STAFFING",
      body: "One server called out sick. Covered by moving a bartender to the floor from 5 PM.",
    });
    await add({
      dateChoice: "CURRENT",
      category: "GUEST",
      body: "Table 12's large pepperoni came out underbaked; refired and comped the cannoli. Guests left happy.",
    });
  }

  const [existingNote] = await database
    .select({ id: preShiftNotes.id })
    .from(preShiftNotes)
    .where(eq(preShiftNotes.locationId, manager.locationId))
    .limit(1);

  if (!existingNote) {
    const today = (await readLocationClock(database, manager.locationId, new Date())).businessDate;
    const [serverPosition] = await database
      .select({ id: positions.id })
      .from(positions)
      .where(and(eq(positions.organizationId, manager.organizationId), eq(positions.code, "SERVER")));
    const write = async (input: Parameters<typeof createNote>[2]) => {
      notes += 1;
      await createNote(database, manager, input);
    };

    await write({
      businessDate: today,
      title: "Tonight's focus",
      body: "Full book from 6 to 7:30 and a big takeout rush on Friday nights. Greet every table within two minutes and check back after the first bite.",
      pinned: true,
      positionIds: [],
    });
    await write({
      businessDate: today,
      title: "Specials and 86",
      body: "Special: hot honey soppressata pizza, 14-inch only. 86: tiramisu until Thursday's bake.",
      pinned: false,
      positionIds: serverPosition ? [serverPosition.id] : [],
    });
    await write({
      businessDate: addDays(today, 1),
      title: "Private party",
      body: "Little league team of 18 in the back room at 6 PM: six large pizzas and pitchers of soda. Two servers assigned; see the manager before service.",
      pinned: false,
      positionIds: [],
    });
  }

  return { entries, notes };
}
