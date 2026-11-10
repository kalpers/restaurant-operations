export { formatMoney } from "@/components/format/money";

export function formatInstant(value: Date | null): string {
  return value ? `${value.toISOString().replace("T", " ").slice(0, 16)} UTC` : "open-ended";
}

/** "Choose 1", "Choose 2 to 3", "Choose up to 2", "Choose any number". */
export function describeSelection(minimum: number, maximum: number | null): string {
  if (maximum === null) {
    return minimum === 0 ? "Choose any number" : `Choose at least ${minimum}`;
  }

  if (minimum === maximum) {
    return `Choose ${minimum}`;
  }

  return minimum === 0 ? `Choose up to ${maximum}` : `Choose ${minimum} to ${maximum}`;
}

export const SELECTION_TYPE_OPTIONS = [
  { value: "OPTIONAL_SINGLE", label: "Optional, one choice" },
  { value: "REQUIRED_SINGLE", label: "Required, one choice" },
  { value: "OPTIONAL_MULTIPLE", label: "Optional, several choices" },
  { value: "REQUIRED_MULTIPLE", label: "Required, several choices" },
];

export const ITEM_TYPE_OPTIONS = [
  { value: "FOOD", label: "Food" },
  { value: "BEVERAGE", label: "Beverage" },
  { value: "ALCOHOL", label: "Alcohol" },
  { value: "OTHER", label: "Other" },
];

export const PREPARATION_EFFECT_OPTIONS = [
  { value: "NONE", label: "None" },
  { value: "INSTRUCTION", label: "Kitchen instruction" },
  { value: "ADD_COMPONENT", label: "Adds a component" },
  { value: "REMOVE_COMPONENT", label: "Removes a component" },
  { value: "ADJUST_COMPONENT", label: "Adjusts a component" },
];

export const STATION_TYPE_OPTIONS = [
  { value: "KITCHEN", label: "Kitchen" },
  { value: "BAR", label: "Bar" },
  { value: "EXPO", label: "Expo" },
];
