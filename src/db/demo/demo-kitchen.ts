/**
 * Demo menu, recipes and inventory for local development. Opt-in (`npm run db:seed:demo`),
 * never part of the baseline seeds. It builds on the baseline seeds: the Main Menu, its
 * categories and prep stations, the unit vocabulary, the six demo inventory items and the
 * DEMO_FOODS supplier. Records are identified by their codes, so a rerun adds nothing twice.
 * Stock is posted through the real services (received purchase orders and waste), so the
 * ledger, balances and costs are all consistent.
 */

export type DemoInventoryItem = {
  code: string;
  name: string;
  measurementType: "COUNT" | "WEIGHT" | "VOLUME";
  baseUnit: string;
  conversions: { from: string; to: string; factor: string }[];
  /** Base units at MAIN. */
  levels: { par: string; reorder: string; target: string };
};

/** Added to the six baseline items (GROUND_BEEF, BRIOCHE_BUN, AMERICAN_CHEESE, BACON, TITOS_VODKA, LIME_JUICE). */
export const DEMO_INVENTORY_ITEMS: readonly DemoInventoryItem[] = [
  {
    code: "SWISS_CHEESE",
    name: "Swiss cheese",
    measurementType: "COUNT",
    baseUnit: "SLICE",
    conversions: [{ from: "PACK", to: "SLICE", factor: "120.000000" }],
    levels: { par: "120.0000", reorder: "40.0000", target: "120.0000" },
  },
  {
    code: "YELLOW_ONION",
    name: "Yellow onion",
    measurementType: "WEIGHT",
    baseUnit: "OZ_WEIGHT",
    conversions: [{ from: "BAG", to: "LB", factor: "10.000000" }],
    levels: { par: "320.0000", reorder: "80.0000", target: "320.0000" },
  },
  {
    code: "PICKLE_CHIPS",
    name: "Pickle chips",
    measurementType: "COUNT",
    baseUnit: "EACH",
    conversions: [{ from: "BAG", to: "EACH", factor: "400.000000" }],
    levels: { par: "800.0000", reorder: "200.0000", target: "800.0000" },
  },
  {
    code: "FRENCH_FRIES",
    name: "French fries (frozen)",
    measurementType: "WEIGHT",
    baseUnit: "OZ_WEIGHT",
    conversions: [{ from: "CASE", to: "LB", factor: "30.000000" }],
    levels: { par: "960.0000", reorder: "320.0000", target: "960.0000" },
  },
  {
    code: "CHICKEN_WINGS",
    name: "Chicken wings",
    measurementType: "COUNT",
    baseUnit: "EACH",
    conversions: [{ from: "CASE", to: "EACH", factor: "200.000000" }],
    levels: { par: "400.0000", reorder: "100.0000", target: "400.0000" },
  },
  {
    code: "SIMPLE_SYRUP",
    name: "Simple syrup",
    measurementType: "VOLUME",
    baseUnit: "FL_OZ",
    conversions: [{ from: "BOTTLE", to: "FL_OZ", factor: "32.000000" }],
    levels: { par: "64.0000", reorder: "16.0000", target: "64.0000" },
  },
  {
    code: "HOUSE_IPA",
    name: "House IPA (bottle)",
    measurementType: "COUNT",
    baseUnit: "BOTTLE",
    conversions: [{ from: "CASE", to: "BOTTLE", factor: "24.000000" }],
    levels: { par: "96.0000", reorder: "24.0000", target: "96.0000" },
  },
];

export const DEMO_SPIRITS_SUPPLIER = { code: "DEMO_SPIRITS", name: "Demo Spirits & Beverage" };

/** Supplier items for the new items. Baseline items already have DEMO_FOODS supplier items. */
export const DEMO_SUPPLIER_ITEMS = [
  { supplier: "DEMO_FOODS", item: "SWISS_CHEESE", unit: "PACK", sku: "CHZ-SW-120", cost: "21.5000" },
  { supplier: "DEMO_FOODS", item: "YELLOW_ONION", unit: "BAG", sku: "ONI-10", cost: "8.9000" },
  { supplier: "DEMO_FOODS", item: "PICKLE_CHIPS", unit: "BAG", sku: "PKL-400", cost: "14.0000" },
  { supplier: "DEMO_FOODS", item: "FRENCH_FRIES", unit: "CASE", sku: "FRY-30", cost: "38.0000" },
  { supplier: "DEMO_FOODS", item: "CHICKEN_WINGS", unit: "CASE", sku: "WNG-200", cost: "96.0000" },
  { supplier: "DEMO_SPIRITS", item: "TITOS_VODKA", unit: "CASE", sku: "TITO-1L-12", cost: "300.0000" },
  { supplier: "DEMO_SPIRITS", item: "SIMPLE_SYRUP", unit: "BOTTLE", sku: "SYR-32", cost: "6.5000" },
  { supplier: "DEMO_SPIRITS", item: "HOUSE_IPA", unit: "CASE", sku: "IPA-24", cost: "38.4000" },
  { supplier: "DEMO_SPIRITS", item: "LIME_JUICE", unit: "BOTTLE", sku: "LIME-32", cost: "7.2500" },
] as const;

/** Listed costs for the baseline DEMO_FOODS supplier items, which the seed leaves blank. */
export const DEMO_FOODS_COSTS: Record<string, string> = {
  GROUND_BEEF: "5.4900",
  BRIOCHE_BUN: "7.2000",
  AMERICAN_CHEESE: "18.0000",
  BACON: "54.0000",
};

/**
 * Purchase orders that build up stock. Quantities are in each supplier item's purchase
 * unit. `receive` is what arrives per line, so the demo shows received, partially received
 * and still-draft orders. `status` is the state each order ends in.
 */
export const DEMO_PURCHASE_ORDERS = [
  {
    supplier: "DEMO_FOODS",
    status: "RECEIVED",
    lines: [
      { item: "GROUND_BEEF", quantity: "40", receive: "40" },
      { item: "BRIOCHE_BUN", quantity: "8", receive: "8" },
      { item: "AMERICAN_CHEESE", quantity: "2", receive: "2" },
      { item: "SWISS_CHEESE", quantity: "1", receive: "1" },
      { item: "BACON", quantity: "1", receive: "1" },
      { item: "YELLOW_ONION", quantity: "2", receive: "2" },
      { item: "PICKLE_CHIPS", quantity: "2", receive: "2" },
    ],
  },
  {
    supplier: "DEMO_SPIRITS",
    status: "PARTIALLY_RECEIVED",
    lines: [
      { item: "TITOS_VODKA", quantity: "1", receive: "1" },
      { item: "SIMPLE_SYRUP", quantity: "2", receive: "2" },
      { item: "HOUSE_IPA", quantity: "4", receive: "4" },
      // Lime juice arrives short so it shows up as low stock.
      { item: "LIME_JUICE", quantity: "4", receive: "1" },
    ],
  },
  {
    supplier: "DEMO_FOODS",
    status: "PARTIALLY_RECEIVED",
    lines: [
      { item: "FRENCH_FRIES", quantity: "3", receive: "2" },
      { item: "CHICKEN_WINGS", quantity: "2", receive: "1" },
    ],
  },
  {
    supplier: "DEMO_FOODS",
    status: "DRAFT",
    lines: [
      { item: "GROUND_BEEF", quantity: "20", receive: "0" },
      { item: "BRIOCHE_BUN", quantity: "4", receive: "0" },
    ],
  },
] as const;

/** Marks the demo orders, so a rerun knows stock has already been built. */
export const DEMO_ORDER_NOTE = "Demo data";

export const DEMO_WASTE = [
  { item: "BRIOCHE_BUN", quantity: "3", unit: "EACH", reason: "SPOILAGE", notes: "Stale by close" },
  { item: "FRENCH_FRIES", quantity: "1", unit: "LB", reason: "PREP_WASTE", notes: "Dropped basket" },
] as const;

export type DemoMenuItem = {
  code: string;
  name: string;
  description: string;
  itemType: "FOOD" | "BEVERAGE" | "ALCOHOL";
  category: string;
  price: string;
  stations: string[];
  recipe: {
    yieldQuantity: string;
    yieldUnit: string;
    notes: string;
    ingredients: { item: string; quantity: string; unit: string; note?: string }[];
  };
};

export const DEMO_MENU_ITEMS: readonly DemoMenuItem[] = [
  {
    code: "BACON_CHEESEBURGER",
    name: "Bacon Cheeseburger",
    description: "Half-pound patty, American cheese, bacon, onion and pickles on brioche.",
    itemType: "FOOD",
    category: "BURGERS",
    price: "14.99",
    stations: ["GRILL"],
    recipe: {
      yieldQuantity: "1",
      yieldUnit: "EACH",
      notes: "Season patty, grill to temperature, cheese in the last minute. Toast bun.",
      ingredients: [
        { item: "GROUND_BEEF", quantity: "8", unit: "OZ_WEIGHT", note: "One half-pound patty" },
        { item: "BRIOCHE_BUN", quantity: "1", unit: "EACH" },
        { item: "AMERICAN_CHEESE", quantity: "1", unit: "SLICE" },
        { item: "BACON", quantity: "2", unit: "SLICE" },
        { item: "YELLOW_ONION", quantity: "0.5", unit: "OZ_WEIGHT", note: "Sliced thin" },
        { item: "PICKLE_CHIPS", quantity: "3", unit: "EACH" },
      ],
    },
  },
  {
    code: "FRENCH_FRIES",
    name: "French Fries",
    description: "Hand-salted, served hot.",
    itemType: "FOOD",
    category: "APPETIZERS",
    price: "4.50",
    stations: ["FRY"],
    recipe: {
      yieldQuantity: "1",
      yieldUnit: "EACH",
      notes: "Fry at 350°F for 3 minutes. Salt immediately.",
      ingredients: [{ item: "FRENCH_FRIES", quantity: "6", unit: "OZ_WEIGHT" }],
    },
  },
  {
    code: "BUFFALO_WINGS",
    name: "Buffalo Wings",
    description: "Ten wings, tossed in house buffalo sauce.",
    itemType: "FOOD",
    category: "APPETIZERS",
    price: "12.00",
    stations: ["FRY"],
    recipe: {
      yieldQuantity: "1",
      yieldUnit: "EACH",
      notes: "Fry 10 minutes, toss in sauce, plate with celery.",
      ingredients: [{ item: "CHICKEN_WINGS", quantity: "10", unit: "EACH" }],
    },
  },
  {
    code: "TITOS_GIMLET",
    name: "Tito's Gimlet",
    description: "Tito's vodka, fresh lime and simple syrup, shaken.",
    itemType: "ALCOHOL",
    category: "COCKTAILS",
    price: "11.00",
    stations: ["BAR"],
    recipe: {
      yieldQuantity: "1",
      yieldUnit: "EACH",
      notes: "Shake hard over ice, double strain into a chilled coupe.",
      ingredients: [
        { item: "TITOS_VODKA", quantity: "60", unit: "ML" },
        { item: "LIME_JUICE", quantity: "0.75", unit: "FL_OZ" },
        { item: "SIMPLE_SYRUP", quantity: "0.5", unit: "FL_OZ" },
      ],
    },
  },
  {
    code: "HOUSE_IPA",
    name: "House IPA",
    description: "Hoppy and bright. 12 oz bottle.",
    itemType: "ALCOHOL",
    category: "BEER",
    price: "6.50",
    stations: ["BAR"],
    recipe: {
      yieldQuantity: "1",
      yieldUnit: "EACH",
      notes: "Serve cold with a pint glass on the side.",
      ingredients: [{ item: "HOUSE_IPA", quantity: "1", unit: "BOTTLE" }],
    },
  },
];

type DemoModifier = {
  code: string;
  name: string;
  priceAdjustment: string;
  instruction?: string;
  effectType?: "ADD_COMPONENT" | "REMOVE_COMPONENT" | "ADJUST_COMPONENT";
  /** Inventory effects on the Bacon Cheeseburger. */
  effects?: { type: "ADD" | "REMOVE" | "ADJUST"; item: string; quantity?: string; unit?: string }[];
};

export type DemoModifierGroup = {
  code: string;
  name: string;
  selectionType: "OPTIONAL_SINGLE" | "REQUIRED_SINGLE" | "OPTIONAL_MULTIPLE" | "REQUIRED_MULTIPLE";
  minimumSelections: number;
  maximumSelections: number | null;
  modifiers: DemoModifier[];
};

/**
 * The canonical burger's choices: Medium, No Onion, Extra Pickles, and Swiss instead of
 * American (a REMOVE plus an ADD). Temperature is a kitchen instruction only.
 */
export const DEMO_BURGER_GROUPS: readonly DemoModifierGroup[] = [
  {
    code: "BURGER_TEMP",
    name: "Temperature",
    selectionType: "REQUIRED_SINGLE",
    minimumSelections: 1,
    maximumSelections: 1,
    modifiers: [
      { code: "TEMP_RARE", name: "Rare", priceAdjustment: "0.00", instruction: "Cook rare" },
      { code: "TEMP_MEDIUM_RARE", name: "Medium Rare", priceAdjustment: "0.00", instruction: "Cook medium rare" },
      { code: "TEMP_MEDIUM", name: "Medium", priceAdjustment: "0.00", instruction: "Cook medium" },
      { code: "TEMP_WELL_DONE", name: "Well Done", priceAdjustment: "0.00", instruction: "Cook well done" },
    ],
  },
  {
    code: "BURGER_CHEESE",
    name: "Cheese",
    selectionType: "OPTIONAL_SINGLE",
    minimumSelections: 0,
    maximumSelections: 1,
    modifiers: [
      {
        code: "SWISS_FOR_AMERICAN",
        name: "Swiss instead of American",
        priceAdjustment: "0.00",
        effectType: "ADJUST_COMPONENT",
        effects: [
          { type: "REMOVE", item: "AMERICAN_CHEESE" },
          { type: "ADD", item: "SWISS_CHEESE", quantity: "1", unit: "SLICE" },
        ],
      },
    ],
  },
  {
    code: "BURGER_ADDONS",
    name: "Add-ons",
    selectionType: "OPTIONAL_MULTIPLE",
    minimumSelections: 0,
    maximumSelections: 3,
    modifiers: [
      {
        code: "NO_ONION",
        name: "No Onion",
        priceAdjustment: "0.00",
        effectType: "REMOVE_COMPONENT",
        effects: [{ type: "REMOVE", item: "YELLOW_ONION" }],
      },
      {
        code: "EXTRA_PICKLES",
        name: "Extra Pickles",
        priceAdjustment: "0.50",
        effectType: "ADJUST_COMPONENT",
        effects: [{ type: "ADJUST", item: "PICKLE_CHIPS", quantity: "3", unit: "EACH" }],
      },
      {
        code: "EXTRA_BACON",
        name: "Extra Bacon",
        priceAdjustment: "2.00",
        effectType: "ADJUST_COMPONENT",
        effects: [{ type: "ADJUST", item: "BACON", quantity: "2", unit: "SLICE" }],
      },
    ],
  },
];
