export const MENU_ITEM_TYPES = ["FOOD", "BEVERAGE", "ALCOHOL", "OTHER"] as const;
export type MenuItemType = (typeof MENU_ITEM_TYPES)[number];

export const PREPARATION_EFFECT_TYPES = [
  "NONE",
  "INSTRUCTION",
  "ADD_COMPONENT",
  "REMOVE_COMPONENT",
  "ADJUST_COMPONENT",
] as const;
export type PreparationEffectType = (typeof PREPARATION_EFFECT_TYPES)[number];

export const STATION_TYPES = ["KITCHEN", "BAR", "EXPO"] as const;
export type StationType = (typeof STATION_TYPES)[number];
