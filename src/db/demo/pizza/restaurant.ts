/**
 * The demo pizza restaurant's setup at MAIN: the floor, prep stations, menu categories and
 * the one sales tax. Data only; `scripts/demo/restaurant.ts` writes it through the services.
 * The baseline seeds already give MAIN tables T01-T04 and B01-B02, sections DINING_A and BAR,
 * the Grill, Fry, Salad, Bar and Expo stations and the categories Appetizers to Non-Alcoholic.
 */

export const PIZZA_RESTAURANT_NAME = "Demo Pizza Co.";

/** Added to the baseline tables. Areas are the baseline DINING_ROOM and BAR. */
export const PIZZA_TABLES = [
  { areaCode: "DINING_ROOM", tableNumber: "T05", capacity: 4, minimumCapacity: null, sortOrder: 50 },
  { areaCode: "DINING_ROOM", tableNumber: "T06", capacity: 4, minimumCapacity: null, sortOrder: 60 },
  { areaCode: "DINING_ROOM", tableNumber: "T07", capacity: 2, minimumCapacity: null, sortOrder: 70 },
  { areaCode: "DINING_ROOM", tableNumber: "T08", capacity: 2, minimumCapacity: null, sortOrder: 80 },
  { areaCode: "DINING_ROOM", tableNumber: "T09", capacity: 6, minimumCapacity: 3, sortOrder: 90 },
  { areaCode: "DINING_ROOM", tableNumber: "T10", capacity: 4, minimumCapacity: null, sortOrder: 100 },
  { areaCode: "DINING_ROOM", tableNumber: "T11", capacity: 4, minimumCapacity: null, sortOrder: 110 },
  { areaCode: "DINING_ROOM", tableNumber: "T12", capacity: 8, minimumCapacity: 5, sortOrder: 120 },
  { areaCode: "DINING_ROOM", tableNumber: "T13", capacity: 2, minimumCapacity: null, sortOrder: 130 },
  { areaCode: "DINING_ROOM", tableNumber: "T14", capacity: 4, minimumCapacity: null, sortOrder: 140 },
  { areaCode: "BAR", tableNumber: "B03", capacity: 2, minimumCapacity: null, sortOrder: 30 },
  { areaCode: "BAR", tableNumber: "B04", capacity: 2, minimumCapacity: null, sortOrder: 40 },
  { areaCode: "BAR", tableNumber: "B05", capacity: 2, minimumCapacity: null, sortOrder: 50 },
  { areaCode: "BAR", tableNumber: "B06", capacity: 2, minimumCapacity: null, sortOrder: 60 },
  { areaCode: "BAR", tableNumber: "B07", capacity: 4, minimumCapacity: null, sortOrder: 70 },
  { areaCode: "BAR", tableNumber: "B08", capacity: 4, minimumCapacity: null, sortOrder: 80 },
] as const;

/** Server sections: the front room (baseline DINING_A) and a new back room. */
export const PIZZA_SECTIONS = [
  { code: "DINING_A", name: "Front room", areaCode: "DINING_ROOM", tables: ["T01", "T02", "T03", "T04", "T05", "T06", "T07"] },
  { code: "DINING_B", name: "Back room", areaCode: "DINING_ROOM", tables: ["T08", "T09", "T10", "T11", "T12", "T13", "T14"] },
  { code: "BAR", name: "Bar", areaCode: "BAR", tables: ["B01", "B02", "B03", "B04", "B05", "B06", "B07", "B08"] },
] as const;

export const PIZZA_STATIONS = [
  { code: "PIZZA_OVEN", name: "Pizza Oven", stationType: "KITCHEN" as const, sortOrder: 5 },
  { code: "SANDWICH", name: "Sandwich", stationType: "KITCHEN" as const, sortOrder: 15 },
] as const;

/** Categories the baseline doesn't have, placed among the baseline ones. */
export const PIZZA_CATEGORIES = [
  { code: "PIZZA", name: "Pizza & Calzones", displayOrder: 15 },
  { code: "SANDWICHES", name: "Sandwiches", displayOrder: 25 },
  { code: "DESSERTS", name: "Desserts", displayOrder: 45 },
  { code: "WINE", name: "Wine", displayOrder: 55 },
  { code: "SPIRITS", name: "Spirits", displayOrder: 65 },
] as const;

/** Michigan's 6% sales tax on everything the restaurant sells, added on top of the price. */
export const PIZZA_SALES_TAX = {
  code: "SALES_TAX",
  name: "Sales tax (6%)",
  description: "Michigan sales tax on food and drink, added to the check.",
  ratePercent: "6",
  priceIncludesTax: false,
} as const;

/** Online booking: dinner hours, the same every day. */
export const PIZZA_BOOKING_HOURS = { startsAt: "16:30", endsAt: "20:30" } as const;
