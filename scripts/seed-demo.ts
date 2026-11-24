import { and, eq, inArray, max } from "drizzle-orm";

import { loadLocalEnv } from "../src/config/tooling-env";
import { closeDatabase, getDatabase } from "../src/db";
import { PIZZA_GUESTS } from "../src/db/demo/pizza/guests";
import { locations, menuItems, recipes, recipeVersions } from "../src/db/schema";
import { findLocationClockSettings } from "../src/modules/scheduling/repositories/forecast-repository";
import { businessDateOf } from "../src/shared/time/business-date-service";
import { addDays, dayOfWeek, localToInstant } from "../src/shared/time/zoned-time";

import { seedGuestProfiles } from "./demo-guests-allergens";
import { seedDemoBriefings } from "./demo/briefings";
import { installShiftedClock, restoreClock, setClock } from "./demo/clock";
import { seedDemoFollowUps } from "./demo/follow-ups";
import { seedDemoGiftCards } from "./demo/gift-cards";
import { seedRunTracker } from "./demo/helpers";
import { HISTORY_DAYS, seedPizzaHistory } from "./demo/history";
import { seedHappyHour, seedPizzaLive } from "./demo/live";
import { seedDemoLoyalty, seedDemoRedemption } from "./demo/loyalty";
import { seedPizzaMenu } from "./demo/menu";
import { seedPizzaRestaurant } from "./demo/restaurant";
import { seedPizzaStaff, seedPizzaTimeOff } from "./demo/staff";
import { seedDemoPhase36 } from "./demo/phase-36";
import { seedDemoPhase34 } from "./demo/unclaimed-and-erase";
import { assertLocalDevelopment, mainOwnerActor } from "./local-seed-guard";

// `npm run db:seed:demo`: a pizza restaurant ("Demo Pizza Co.") at MAIN with sandwiches,
// appetizers and a full bar, its staff and their availability, six weeks of service history
// and today's service in progress. Local dev database only, after `bootstrap:owner`. Everything
// goes through the real services; every step skips what is already there, so running it twice
// adds nothing. See docs/Demo-Data.md for what it builds and where to look.

/** Menu items only the old burger demo made; their presence means the dev DB needs a reset. */
const OLD_DEMO_ITEMS = ["FISH_TACOS", "MAC_AND_CHEESE", "VEGGIE_BURGER", "DEMO_FORECAST_PLATE"];
const TIME_ZONE_FALLBACK = "America/Detroit";

async function main(): Promise<void> {
  loadLocalEnv();
  assertLocalDevelopment("Demo data");

  const database = getDatabase();

  try {
    const owner = await mainOwnerActor("employees.create");
    const old = await database
      .select({ code: menuItems.code })
      .from(menuItems)
      .where(and(eq(menuItems.organizationId, owner.organizationId), inArray(menuItems.code, OLD_DEMO_ITEMS)));
    const [uptown] = await database
      .select({ id: locations.id })
      .from(locations)
      .where(and(eq(locations.organizationId, owner.organizationId), eq(locations.locationCode, "UPTOWN")));

    if (old.length > 0 || uptown) {
      throw new Error(
        "This database has the earlier burger demo. Start from an empty one: `npm run db:reset`, `npm run db:seed`, `npm run bootstrap:owner`, then `npm run db:seed:demo`.",
      );
    }

    const clock = await findLocationClockSettings(database, owner.locationId);
    const timeZone = clock?.timeZone ?? TIME_ZONE_FALLBACK;
    const today = businessDateOf(new Date(), { timeZone, businessDayCutoff: clock?.businessDayCutoff ?? "04:00" });
    let first = addDays(today, -HISTORY_DAYS);

    while (dayOfWeek(first) !== 0) {
      first = addDays(first, -1);
    }

    const at = (date: string, time: string) => localToInstant(date, time, timeZone)!;
    const setupAt = at(addDays(first, -3), "09:00");
    const tracker = await seedRunTracker(database);
    const [location] = await database.select({ code: locations.locationCode }).from(locations).where(eq(locations.id, owner.locationId));

    // ------------------------------------- setup, dated before the history
    installShiftedClock();

    try {
      setClock(setupAt);

      const restaurant = await seedPizzaRestaurant(database, owner);

      console.log(
        `Restaurant: ${restaurant.renamed ? "MAIN renamed Demo Pizza Co., " : ""}${restaurant.tables} tables, ${restaurant.sections} sections, ${restaurant.stations} prep stations, ${restaurant.categories} categories added; 6% sales tax ${restaurant.taxTurnedOn ? "turned on" : "already on"}.`,
      );

      const staff = await seedPizzaStaff(database, owner, today);

      console.log(
        `Staff: ${staff.employees} employees, ${staff.positions} positions, ${staff.availabilityWindows} availability windows, ${staff.certifications} certifications added; template ${staff.templateCreated ? "created" : "already there"}, ${staff.ratios} staffing ratios, tip pool ${staff.tipPool ? "set up" : "already set"}.`,
      );

      // After every recipe already published (a rerun skips the steps above in seconds, so it
      // would otherwise run before the first run's recipes and fail the modifier-effect checks).
      const [published] = await database
        .select({ latest: max(recipeVersions.effectiveFrom) })
        .from(recipeVersions)
        .innerJoin(recipes, eq(recipes.id, recipeVersions.recipeId))
        .where(eq(recipes.organizationId, owner.organizationId));
      const menuAt = new Date(Math.max(setupAt.getTime() + 3_600_000, (published?.latest?.getTime() ?? 0) + 60_000));

      setClock(menuAt);

      const menu = await seedPizzaMenu(database, owner, restaurant.taxCategoryId, menuAt);

      console.log(
        `Menu: burger kitchen (${menu.burgerKitchen}); ${menu.menuItems} pizza-place items, ${menu.ingredients} ingredients, ${menu.groups} modifier groups, ${menu.effects} modifier effects, ${menu.allergenTags} ingredients tagged with allergens, ${menu.nutrition} given nutrition; ${menu.taxed} items moved onto the sales tax.`,
      );

      const happyHour = await seedHappyHour(database, owner);
      const profiles = await seedGuestProfiles(database, owner, PIZZA_GUESTS);

      console.log(`Happy hour ${happyHour ? "added (weekdays 15:00-18:00)" : "already there"}; ${profiles} guest profiles added.`);
    } finally {
      restoreClock();
    }

    const timeOff = await seedPizzaTimeOff(database, owner, today);

    console.log(`Time off: ${timeOff} requests for next week added (one approved, one waiting).`);

    // ------------------------------------------------------- six weeks back
    const history = await seedPizzaHistory(database, owner, { today, first, at, ...tracker });

    console.log(
      `History: ${history.periods} schedule weeks (${history.unfilledShifts} shift slots left open), ${history.checks} closed checks, ${history.purchaseOrders} purchase orders received, ${history.counts} counts, ${history.wasteDays} waste days, ${history.punches} shifts punched, ${history.declarations} cash tip declarations, ${history.tipDays} tip days finalized.`,
    );

    // ------------------------------------------------------------- today
    const live = await seedPizzaLive(database, owner, { ...tracker, today, timeZone, locationCode: location!.code });

    console.log(
      `Today: ${live.deliveries} deliveries received, ${live.lots} dated mozzarella lots, ${live.outages} items 86'd, ${live.reservations} upcoming reservations, ${live.waitlist} waitlist parties, ${live.openTables} tables mid-meal, ${live.dirtyTables} to clean; shift swap ${live.swap}.`,
    );

    // ---------------------------------------- guests, loyalty, gift cards, log
    const loyalty = await seedDemoLoyalty(database, owner, owner);

    console.log(
      `Loyalty: program ${loyalty.programEnabled ? "turned on (1 point per $1, 5 per visit)" : "left as it was"}, ${loyalty.rewards} rewards added, ${loyalty.profiles} guests given starting points; redemption ${await seedDemoRedemption(database, owner)}.`,
    );

    const giftCards = await seedDemoGiftCards(database, owner, owner);

    console.log(`Gift cards: ${giftCards.summary}.`);

    const followUps = await seedDemoFollowUps(database, owner);

    console.log(`Follow-ups: ${followUps.lines.join("; ")}.`);
    console.log(`Unclaimed property and erase: ${(await seedDemoPhase34(database, owner)).join("; ")}.`);

    const briefings = await seedDemoBriefings(database, owner);

    console.log(`Manager log and pre-shift: ${briefings.entries} log entries and ${briefings.notes} notes added.`);

    for (const line of await seedDemoPhase36(database, owner)) {
      console.log(line);
    }

    const codes = [...giftCards.codes, ...followUps.codes];

    if (codes.length > 0) {
      // Shown once, here, like the sale screen; the database keeps only each code's hash.
      console.log("Demo gift card codes (shown once, not stored):");

      for (const card of codes) {
        console.log(`  ${card.cardNumber}  ${card.code}  balance ${card.balance}`);
      }
    }
  } finally {
    await closeDatabase();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Demo seeding failed.");
  process.exitCode = 1;
});
