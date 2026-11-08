import { addDays, localDateOf, localMinutesOf, timeToMinutes } from "./zoned-time";

export type BusinessDateSettings = {
  timeZone: string;
  /** "HH:MM" or "HH:MM:SS" local time at which a new operating day begins. */
  businessDayCutoff: string;
};

/**
 * The one authority for restaurant business dates. Before the location's local cutoff, an
 * instant still belongs to the previous operating day: with a 4:00 AM cutoff, Saturday
 * 1:15 AM is Friday. No module may work this out for itself.
 */
export function businessDateOf(
  instant: Date | number,
  settings: BusinessDateSettings,
): string {
  const localDate = localDateOf(instant, settings.timeZone);
  const beforeCutoff =
    localMinutesOf(instant, settings.timeZone) <
    timeToMinutes(settings.businessDayCutoff);

  return beforeCutoff ? addDays(localDate, -1) : localDate;
}
