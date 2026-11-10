import { localDateOf, localTimeOf } from "@/shared/time/zoned-time";

// Light-theme position colors. Each pairs a pale fill with a dark border and near-black
// text, so labels pass WCAG AA contrast. Bars always carry the position name as text too.
// The length must match POSITION_COLOR_COUNT in the timeline layout rules.
export const POSITION_PALETTE = [
  "bg-sky-100 border-sky-700 text-sky-950",
  "bg-amber-100 border-amber-700 text-amber-950",
  "bg-emerald-100 border-emerald-700 text-emerald-950",
  "bg-rose-100 border-rose-700 text-rose-950",
  "bg-violet-100 border-violet-700 text-violet-950",
  "bg-lime-100 border-lime-700 text-lime-950",
  "bg-cyan-100 border-cyan-700 text-cyan-950",
  "bg-orange-100 border-orange-700 text-orange-950",
] as const;

export const SWATCH_PALETTE = [
  "bg-sky-600",
  "bg-amber-600",
  "bg-emerald-600",
  "bg-rose-600",
  "bg-violet-600",
  "bg-lime-600",
  "bg-cyan-600",
  "bg-orange-600",
] as const;

/** Diagonal stripes for unfilled slots, so they don't rely on color. */
export const HATCHED_STYLE = {
  backgroundImage:
    "repeating-linear-gradient(45deg, rgb(229 229 229) 0 6px, rgb(255 255 255) 6px 12px)",
};

export function clockTime(isoInstant: string, timeZone: string): string {
  return localTimeOf(Date.parse(isoInstant), timeZone);
}

export function dateAndTime(isoInstant: string, timeZone: string): string {
  const instant = Date.parse(isoInstant);

  return `${localDateOf(instant, timeZone)} ${localTimeOf(instant, timeZone)}`;
}
