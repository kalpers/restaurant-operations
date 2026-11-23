/**
 * The demo pizza restaurant's menu: ingredients (with supplier, cost, par and allergens),
 * dishes and drinks (with price, category, prep station and recipe) and modifier groups (with
 * their inventory effects). Data only; `scripts/demo/menu.ts` writes it through the services.
 * Opt-in (`npm run db:seed:demo`), never part of the baseline seeds.
 *
 * The burger kitchen (src/db/demo/demo-kitchen.ts: Bacon Cheeseburger, French Fries, Buffalo
 * Wings, Tito's Gimlet, House IPA) is part of this menu and is seeded first, so the canonical
 * Bacon Cheeseburger and the Phase 13 validation fixture keep working. Its ingredients
 * (BACON, YELLOW_ONION, FRENCH_FRIES, TITOS_VODKA, LIME_JUICE, SIMPLE_SYRUP, ...) are reused here.
 */

export type DemoSupplierCode = "DEMO_FOODS" | "DEMO_SPIRITS";

export type PizzaIngredient = {
  code: string;
  name: string;
  measurementType: "COUNT" | "WEIGHT" | "VOLUME";
  baseUnit: string;
  conversions: { from: string; to: string; factor: string }[];
  supplier: DemoSupplierCode;
  purchaseUnit: string;
  /** Per purchase unit. */
  cost: string;
  /** In base units at MAIN. */
  levels: { par: string; reorder: string };
  allergens: readonly string[];
};

const LB = (pounds: string) => [{ from: "CASE", to: "LB", factor: pounds }];
const food = (
  code: string,
  name: string,
  measurementType: PizzaIngredient["measurementType"],
  baseUnit: string,
  conversions: PizzaIngredient["conversions"],
  purchaseUnit: string,
  cost: string,
  par: string,
  reorder: string,
  allergens: readonly string[] = [],
): PizzaIngredient => ({ code, name, measurementType, baseUnit, conversions, supplier: "DEMO_FOODS", purchaseUnit, cost, levels: { par, reorder }, allergens });
const drink = (...args: Parameters<typeof food>): PizzaIngredient => ({ ...food(...args), supplier: "DEMO_SPIRITS" });
const liquor = (code: string, name: string, caseCost: string, par = "6000", reorder = "2000") =>
  drink(code, name, "VOLUME", "ML", [{ from: "CASE", to: "BOTTLE", factor: "12" }, { from: "BOTTLE", to: "L", factor: "1" }], "CASE", caseCost, par, reorder);
const wine = (code: string, name: string, caseCost: string) =>
  drink(code, name, "VOLUME", "ML", [{ from: "CASE", to: "BOTTLE", factor: "12" }, { from: "BOTTLE", to: "ML", factor: "750" }], "CASE", caseCost, "9000", "3000");
const bottle = (code: string, name: string, cost: string, milliliters = "1000", par = "2000", reorder = "600") =>
  drink(code, name, "VOLUME", "ML", [{ from: "BOTTLE", to: "ML", factor: milliliters }], "BOTTLE", cost, par, reorder);

export const PIZZA_INGREDIENTS: readonly PizzaIngredient[] = [
  // Pizza line
  food("PIZZA_DOUGH", "Pizza dough", "WEIGHT", "OZ_WEIGHT", LB("25"), "CASE", "32.0000", "1600", "500", ["WHEAT"]),
  food("GF_CRUST", 'Gluten-free crust, 10"', "COUNT", "EACH", [{ from: "CASE", to: "EACH", factor: "24" }], "CASE", "42.0000", "48", "12"),
  food("PIZZA_SAUCE", "Pizza sauce", "VOLUME", "FL_OZ", [{ from: "CASE", to: "FL_OZ", factor: "640" }], "CASE", "36.0000", "1280", "320"),
  food("MOZZARELLA", "Shredded mozzarella", "WEIGHT", "OZ_WEIGHT", LB("20"), "CASE", "78.0000", "1600", "480", ["MILK"]),
  food("FRESH_MOZZARELLA", "Fresh mozzarella", "WEIGHT", "OZ_WEIGHT", LB("6"), "CASE", "42.0000", "192", "48", ["MILK"]),
  food("RICOTTA", "Ricotta", "WEIGHT", "OZ_WEIGHT", LB("6"), "CASE", "24.0000", "192", "48", ["MILK"]),
  food("PARMESAN", "Grated parmesan", "WEIGHT", "OZ_WEIGHT", [{ from: "BAG", to: "LB", factor: "5" }], "BAG", "29.0000", "160", "40", ["MILK"]),
  food("PROVOLONE", "Sliced provolone", "COUNT", "SLICE", [{ from: "PACK", to: "SLICE", factor: "120" }], "PACK", "19.0000", "360", "120", ["MILK"]),
  food("PEPPERONI", "Pepperoni", "WEIGHT", "OZ_WEIGHT", LB("10"), "CASE", "52.0000", "480", "160"),
  food("ITALIAN_SAUSAGE", "Italian sausage", "WEIGHT", "OZ_WEIGHT", LB("10"), "CASE", "46.0000", "400", "120"),
  food("HAM", "Ham", "WEIGHT", "OZ_WEIGHT", LB("10"), "CASE", "40.0000", "160", "48"),
  food("CHICKEN_BREAST", "Grilled chicken breast", "WEIGHT", "OZ_WEIGHT", LB("20"), "CASE", "88.0000", "480", "160"),
  food("MUSHROOMS", "Sliced mushrooms", "WEIGHT", "OZ_WEIGHT", LB("10"), "CASE", "28.0000", "240", "64"),
  food("GREEN_PEPPER", "Green peppers", "WEIGHT", "OZ_WEIGHT", LB("10"), "CASE", "22.0000", "240", "64"),
  food("BLACK_OLIVES", "Black olives", "WEIGHT", "OZ_WEIGHT", LB("6"), "CASE", "30.0000", "128", "32"),
  food("JALAPENOS", "Jalapeños", "WEIGHT", "OZ_WEIGHT", LB("6"), "CASE", "18.0000", "96", "24"),
  food("ROMA_TOMATO", "Roma tomatoes", "WEIGHT", "OZ_WEIGHT", LB("25"), "CASE", "34.0000", "320", "96"),
  food("FRESH_BASIL", "Fresh basil", "WEIGHT", "OZ_WEIGHT", [{ from: "PACK", to: "LB", factor: "1" }], "PACK", "12.0000", "32", "8"),
  food("GARLIC_OIL", "Garlic oil", "VOLUME", "FL_OZ", [{ from: "BOTTLE", to: "FL_OZ", factor: "128" }], "BOTTLE", "18.0000", "256", "64"),
  food("BBQ_SAUCE", "BBQ sauce", "VOLUME", "FL_OZ", [{ from: "BOTTLE", to: "FL_OZ", factor: "128" }], "BOTTLE", "14.0000", "128", "32"),
  food("BUFFALO_SAUCE", "Buffalo sauce", "VOLUME", "FL_OZ", [{ from: "BOTTLE", to: "FL_OZ", factor: "128" }], "BOTTLE", "16.0000", "128", "32", ["MILK"]),
  // Sandwich line
  food("SALAMI", "Genoa salami", "WEIGHT", "OZ_WEIGHT", LB("6"), "CASE", "48.0000", "128", "32"),
  food("CAPICOLA", "Capicola", "WEIGHT", "OZ_WEIGHT", LB("6"), "CASE", "52.0000", "128", "32"),
  food("TURKEY_BREAST", "Sliced turkey breast", "WEIGHT", "OZ_WEIGHT", LB("10"), "CASE", "55.0000", "160", "48"),
  food("SHAVED_STEAK", "Shaved ribeye", "WEIGHT", "OZ_WEIGHT", LB("10"), "CASE", "85.0000", "320", "96"),
  food("MEATBALLS", "Meatballs (2 oz)", "COUNT", "EACH", [{ from: "CASE", to: "EACH", factor: "160" }], "CASE", "64.0000", "240", "64", ["WHEAT", "EGGS", "MILK"]),
  food("SUB_ROLL", 'Sub roll, 8"', "COUNT", "EACH", [{ from: "CASE", to: "EACH", factor: "48" }], "CASE", "22.0000", "144", "48", ["WHEAT"]),
  food("CIABATTA_ROLL", "Ciabatta roll", "COUNT", "EACH", [{ from: "CASE", to: "EACH", factor: "48" }], "CASE", "22.0000", "48", "16", ["WHEAT"]),
  food("SOURDOUGH_SLICE", "Sourdough, sliced", "COUNT", "EACH", [{ from: "PACK", to: "EACH", factor: "24" }], "PACK", "6.0000", "96", "24", ["WHEAT"]),
  food("ROMAINE", "Romaine hearts", "WEIGHT", "OZ_WEIGHT", LB("20"), "CASE", "31.0000", "480", "160"),
  food("MIXED_GREENS", "Mixed greens", "WEIGHT", "OZ_WEIGHT", LB("3"), "CASE", "18.0000", "144", "48"),
  food("CAESAR_DRESSING", "Caesar dressing", "VOLUME", "FL_OZ", [{ from: "BOTTLE", to: "FL_OZ", factor: "128" }], "BOTTLE", "18.0000", "128", "40", ["EGGS", "FISH", "MILK"]),
  food("ITALIAN_DRESSING", "Italian dressing", "VOLUME", "FL_OZ", [{ from: "BOTTLE", to: "FL_OZ", factor: "128" }], "BOTTLE", "14.0000", "128", "40"),
  food("CROUTONS", "Croutons", "WEIGHT", "OZ_WEIGHT", [{ from: "BAG", to: "LB", factor: "5" }], "BAG", "12.0000", "80", "20", ["WHEAT"]),
  food("KETTLE_CHIPS", "Kettle chips (bag)", "COUNT", "EACH", [{ from: "CASE", to: "EACH", factor: "64" }], "CASE", "28.0000", "128", "32"),
  // Appetizers and desserts
  food("MOZZARELLA_STICKS", "Mozzarella sticks (frozen)", "COUNT", "EACH", [{ from: "CASE", to: "EACH", factor: "120" }], "CASE", "36.0000", "360", "120", ["MILK", "WHEAT", "EGGS"]),
  food("MARINARA", "Marinara (dipping)", "VOLUME", "FL_OZ", [{ from: "BOTTLE", to: "FL_OZ", factor: "64" }], "BOTTLE", "9.5000", "192", "64"),
  food("CALAMARI", "Breaded calamari", "WEIGHT", "OZ_WEIGHT", LB("10"), "CASE", "78.0000", "160", "48", ["WHEAT"]),
  food("BAGUETTE", "Baguette", "COUNT", "EACH", [{ from: "CASE", to: "EACH", factor: "24" }], "CASE", "20.0000", "24", "8", ["WHEAT"]),
  food("CANNOLI", "Cannoli (filled)", "COUNT", "EACH", [{ from: "CASE", to: "EACH", factor: "48" }], "CASE", "48.0000", "48", "12", ["WHEAT", "MILK", "EGGS"]),
  food("TIRAMISU", "Tiramisu (portion)", "COUNT", "EACH", [{ from: "CASE", to: "EACH", factor: "24" }], "CASE", "60.0000", "24", "8", ["WHEAT", "MILK", "EGGS"]),
  // Bar
  drink("DRAFT_LAGER", "Draft lager (keg)", "VOLUME", "FL_OZ", [{ from: "CASE", to: "FL_OZ", factor: "1984" }], "CASE", "135.0000", "3968", "1000", ["WHEAT"]),
  drink("SEASONAL_ALE", "Seasonal ale (keg)", "VOLUME", "FL_OZ", [{ from: "CASE", to: "FL_OZ", factor: "1984" }], "CASE", "165.0000", "1984", "500", ["WHEAT"]),
  drink("DOMESTIC_BOTTLE", "Domestic beer (bottle)", "COUNT", "EACH", [{ from: "CASE", to: "EACH", factor: "24" }], "CASE", "28.0000", "96", "24", ["WHEAT"]),
  drink("IMPORT_BOTTLE", "Imported beer (bottle)", "COUNT", "EACH", [{ from: "CASE", to: "EACH", factor: "24" }], "CASE", "38.0000", "72", "24", ["WHEAT"]),
  wine("CHIANTI", "Chianti", "144.0000"),
  wine("PINOT_GRIGIO", "Pinot grigio", "132.0000"),
  wine("CABERNET", "Cabernet sauvignon", "168.0000"),
  wine("PROSECCO", "Prosecco", "156.0000"),
  liquor("TEQUILA_BLANCO", "Tequila blanco", "260.0000"),
  liquor("BOURBON", "Bourbon", "330.0000"),
  liquor("WELL_WHISKEY", "Well whiskey", "180.0000"),
  liquor("WELL_VODKA", "Well vodka", "150.0000"),
  liquor("GIN", "Gin", "220.0000"),
  bottle("TRIPLE_SEC", "Triple sec", "14.0000"),
  bottle("CAMPARI", "Campari", "28.0000"),
  bottle("APEROL", "Aperol", "26.0000"),
  bottle("SWEET_VERMOUTH", "Sweet vermouth", "14.0000", "750", "1500", "500"),
  bottle("COFFEE_LIQUEUR", "Coffee liqueur", "22.0000", "750", "1500", "500"),
  bottle("ANGOSTURA_BITTERS", "Angostura bitters", "11.0000", "200", "200", "60"),
  drink("GINGER_BEER", "Ginger beer (can)", "COUNT", "EACH", [{ from: "CASE", to: "EACH", factor: "24" }], "CASE", "22.0000", "72", "24"),
  drink("COLD_BREW", "Cold brew concentrate", "VOLUME", "FL_OZ", [{ from: "BOX", to: "FL_OZ", factor: "128" }], "BOX", "24.0000", "128", "32"),
  drink("SODA_SYRUP", "Fountain soda syrup", "VOLUME", "FL_OZ", [{ from: "BOX", to: "FL_OZ", factor: "640" }], "BOX", "55.0000", "1280", "320"),
  drink("ICED_TEA_BREW", "Iced tea (brewed)", "VOLUME", "FL_OZ", [{ from: "BOX", to: "FL_OZ", factor: "384" }], "BOX", "12.0000", "768", "192"),
  drink("LEMONADE_MIX", "Lemonade", "VOLUME", "FL_OZ", [{ from: "BOX", to: "FL_OZ", factor: "384" }], "BOX", "18.0000", "768", "192"),
  drink("ITALIAN_SODA_SYRUP", "Italian soda syrup", "VOLUME", "FL_OZ", [{ from: "BOTTLE", to: "FL_OZ", factor: "32" }], "BOTTLE", "9.0000", "96", "32"),
];

/** The one lot-tracked ingredient (first to expire, first out), with dated lots on arrival. */
export const LOT_TRACKED_INGREDIENTS = ["MOZZARELLA"] as const;

export type PizzaDish = {
  code: string;
  name: string;
  description: string;
  category: string;
  itemType: "FOOD" | "BEVERAGE" | "ALCOHOL";
  price: string;
  station: string;
  ingredients: { item: string; quantity: string; unit: string }[];
  /** Modifier groups attached, in display order. */
  groups?: readonly string[];
};

const PIZZA_GROUPS = ["PIZZA_SIZE", "PIZZA_CRUST", "PIZZA_TOPPINGS"] as const;
const SANDWICH_GROUPS = ["SANDWICH_SIDE"] as const;
const base = [
  { item: "PIZZA_DOUGH", quantity: "10", unit: "OZ_WEIGHT" },
  { item: "PIZZA_SAUCE", quantity: "3", unit: "FL_OZ" },
  { item: "MOZZARELLA", quantity: "4", unit: "OZ_WEIGHT" },
];
const pizza = (
  code: string,
  name: string,
  description: string,
  price: string,
  extra: PizzaDish["ingredients"],
  crust: PizzaDish["ingredients"] = base,
): PizzaDish => ({ code, name, description, category: "PIZZA", itemType: "FOOD", price, station: "PIZZA_OVEN", ingredients: [...crust, ...extra], groups: PIZZA_GROUPS });
const sandwich = (code: string, name: string, description: string, price: string, ingredients: PizzaDish["ingredients"], station = "SANDWICH"): PizzaDish => ({
  code,
  name,
  description,
  category: "SANDWICHES",
  itemType: "FOOD",
  price,
  station,
  ingredients,
  groups: SANDWICH_GROUPS,
});
const oz = (item: string, quantity: string) => ({ item, quantity, unit: "OZ_WEIGHT" });
const floz = (item: string, quantity: string) => ({ item, quantity, unit: "FL_OZ" });
const each = (item: string, quantity: string) => ({ item, quantity, unit: "EACH" });
const ml = (item: string, quantity: string) => ({ item, quantity, unit: "ML" });
const bar = (code: string, name: string, description: string, category: string, price: string, ingredients: PizzaDish["ingredients"], groups?: readonly string[]): PizzaDish => ({
  code,
  name,
  description,
  category,
  itemType: category === "NON_ALCOHOLIC" ? "BEVERAGE" : "ALCOHOL",
  price,
  station: "BAR",
  ingredients,
  groups,
});

/** Prices exclude the 6% sales tax, which is added on top of the check. */
export const PIZZA_DISHES: readonly PizzaDish[] = [
  // Pizza: 10" base recipe; the Size group adds dough, sauce and cheese for 14" and 16".
  pizza("CHEESE_PIZZA", "Cheese Pizza", "Red sauce and whole-milk mozzarella. Build your own with toppings.", "13.00", []),
  pizza("PEPPERONI_PIZZA", "Pepperoni Pizza", "Cup-and-char pepperoni, mozzarella, red sauce.", "15.00", [oz("PEPPERONI", "2")]),
  pizza("MARGHERITA_PIZZA", "Margherita", "Fresh mozzarella, Roma tomato, basil, garlic oil.", "15.00", [oz("FRESH_MOZZARELLA", "3"), oz("ROMA_TOMATO", "2"), oz("FRESH_BASIL", "0.25"), floz("GARLIC_OIL", "0.5")], [
    { item: "PIZZA_DOUGH", quantity: "10", unit: "OZ_WEIGHT" },
    { item: "PIZZA_SAUCE", quantity: "3", unit: "FL_OZ" },
    { item: "MOZZARELLA", quantity: "1", unit: "OZ_WEIGHT" },
  ]),
  pizza("SAUSAGE_PEPPERS_PIZZA", "Sausage & Peppers", "Italian sausage, green peppers, onion.", "16.00", [oz("ITALIAN_SAUSAGE", "2.5"), oz("GREEN_PEPPER", "1"), oz("YELLOW_ONION", "1")]),
  pizza("SUPREME_PIZZA", "Supreme", "Pepperoni, sausage, mushroom, pepper, onion, black olive.", "18.00", [oz("PEPPERONI", "1.5"), oz("ITALIAN_SAUSAGE", "1.5"), oz("MUSHROOMS", "1"), oz("GREEN_PEPPER", "0.75"), oz("YELLOW_ONION", "0.75"), oz("BLACK_OLIVES", "0.75")]),
  pizza("MEAT_LOVERS_PIZZA", "Meat Lovers", "Pepperoni, sausage, ham and bacon.", "18.00", [oz("PEPPERONI", "1.5"), oz("ITALIAN_SAUSAGE", "1.5"), oz("HAM", "1.5"), { item: "BACON", quantity: "2", unit: "SLICE" }]),
  pizza("BBQ_CHICKEN_PIZZA", "BBQ Chicken", "BBQ sauce, grilled chicken, red onion, mozzarella.", "17.00", [oz("CHICKEN_BREAST", "3"), oz("YELLOW_ONION", "1"), floz("BBQ_SAUCE", "2")], [
    { item: "PIZZA_DOUGH", quantity: "10", unit: "OZ_WEIGHT" },
    { item: "MOZZARELLA", quantity: "4", unit: "OZ_WEIGHT" },
  ]),
  pizza("BUFFALO_CHICKEN_PIZZA", "Buffalo Chicken", "Buffalo sauce, grilled chicken, mozzarella.", "17.00", [oz("CHICKEN_BREAST", "3"), floz("BUFFALO_SAUCE", "2")], [
    { item: "PIZZA_DOUGH", quantity: "10", unit: "OZ_WEIGHT" },
    { item: "MOZZARELLA", quantity: "4", unit: "OZ_WEIGHT" },
  ]),
  pizza("VEGGIE_PIZZA", "Garden Veggie", "Mushroom, pepper, onion, black olive, tomato.", "16.00", [oz("MUSHROOMS", "1.25"), oz("GREEN_PEPPER", "1"), oz("YELLOW_ONION", "1"), oz("BLACK_OLIVES", "0.75"), oz("ROMA_TOMATO", "1")]),
  pizza("WHITE_PIZZA", "White Pizza", "Garlic oil, ricotta, mozzarella, parmesan. No red sauce.", "16.00", [oz("RICOTTA", "3"), oz("PARMESAN", "0.5"), floz("GARLIC_OIL", "1")], [
    { item: "PIZZA_DOUGH", quantity: "10", unit: "OZ_WEIGHT" },
    { item: "MOZZARELLA", quantity: "4", unit: "OZ_WEIGHT" },
  ]),
  {
    code: "CALZONE",
    name: "Calzone",
    description: "Ricotta, mozzarella and one topping of your choice, marinara on the side.",
    category: "PIZZA",
    itemType: "FOOD",
    price: "14.00",
    station: "PIZZA_OVEN",
    ingredients: [oz("PIZZA_DOUGH", "12"), oz("RICOTTA", "3"), oz("MOZZARELLA", "4"), floz("MARINARA", "3")],
    groups: ["PIZZA_TOPPINGS"],
  },
  {
    code: "STROMBOLI",
    name: "Stromboli",
    description: "Rolled with ham, salami, pepperoni and provolone.",
    category: "PIZZA",
    itemType: "FOOD",
    price: "15.00",
    station: "PIZZA_OVEN",
    ingredients: [oz("PIZZA_DOUGH", "12"), oz("HAM", "2"), oz("SALAMI", "1.5"), oz("PEPPERONI", "1"), { item: "PROVOLONE", quantity: "3", unit: "SLICE" }, floz("MARINARA", "3")],
  },
  // Sandwiches, each with a side (fries, side salad or chips).
  sandwich("ITALIAN_SUB", "Italian Sub", "Salami, capicola, ham, provolone, lettuce, tomato, Italian dressing.", "13.50", [each("SUB_ROLL", "1"), oz("SALAMI", "2"), oz("CAPICOLA", "2"), oz("HAM", "2"), { item: "PROVOLONE", quantity: "2", unit: "SLICE" }, oz("ROMAINE", "1"), oz("ROMA_TOMATO", "1"), floz("ITALIAN_DRESSING", "0.5")]),
  sandwich("MEATBALL_SUB", "Meatball Sub", "Four meatballs, marinara, provolone, baked in the oven.", "13.00", [each("SUB_ROLL", "1"), each("MEATBALLS", "4"), floz("MARINARA", "3"), { item: "PROVOLONE", quantity: "2", unit: "SLICE" }], "PIZZA_OVEN"),
  sandwich("CHICKEN_PARM_SUB", "Chicken Parm Sub", "Grilled chicken, marinara, mozzarella and parmesan.", "14.00", [each("SUB_ROLL", "1"), oz("CHICKEN_BREAST", "6"), floz("MARINARA", "3"), oz("MOZZARELLA", "2"), oz("PARMESAN", "0.25")], "PIZZA_OVEN"),
  sandwich("PHILLY_CHEESESTEAK", "Philly Cheesesteak", "Shaved ribeye, peppers, onions, provolone.", "14.50", [each("SUB_ROLL", "1"), oz("SHAVED_STEAK", "6"), oz("GREEN_PEPPER", "1"), oz("YELLOW_ONION", "1"), { item: "PROVOLONE", quantity: "2", unit: "SLICE" }]),
  sandwich("TURKEY_CLUB", "Turkey Club", "Turkey, bacon, lettuce and tomato on toasted sourdough.", "13.00", [each("SOURDOUGH_SLICE", "3"), oz("TURKEY_BREAST", "4"), { item: "BACON", quantity: "2", unit: "SLICE" }, oz("ROMAINE", "1"), oz("ROMA_TOMATO", "1")]),
  sandwich("VEGGIE_PANINI", "Grilled Veggie Panini", "Fresh mozzarella, tomato, peppers, basil, garlic oil on ciabatta.", "12.00", [each("CIABATTA_ROLL", "1"), oz("FRESH_MOZZARELLA", "2"), oz("ROMA_TOMATO", "1.5"), oz("GREEN_PEPPER", "1"), oz("FRESH_BASIL", "0.1"), floz("GARLIC_OIL", "0.5")]),
  // Appetizers (French Fries and Buffalo Wings come from the burger kitchen).
  { code: "GARLIC_KNOTS", name: "Garlic Knots", description: "Six knots, garlic oil, parmesan, marinara.", category: "APPETIZERS", itemType: "FOOD", price: "6.00", station: "PIZZA_OVEN", ingredients: [oz("PIZZA_DOUGH", "6"), floz("GARLIC_OIL", "1"), oz("PARMESAN", "0.25"), floz("MARINARA", "2")] },
  { code: "CHEESY_BREAD", name: "Cheesy Bread", description: "Garlic-oil crust, mozzarella, marinara.", category: "APPETIZERS", itemType: "FOOD", price: "9.00", station: "PIZZA_OVEN", ingredients: [oz("PIZZA_DOUGH", "8"), floz("GARLIC_OIL", "1"), oz("MOZZARELLA", "4"), floz("MARINARA", "2")] },
  { code: "MOZZARELLA_STICKS", name: "Mozzarella Sticks", description: "Six sticks with warm marinara.", category: "APPETIZERS", itemType: "FOOD", price: "9.00", station: "FRY", ingredients: [each("MOZZARELLA_STICKS", "6"), floz("MARINARA", "2")] },
  { code: "FRIED_CALAMARI", name: "Fried Calamari", description: "Lightly breaded, with marinara.", category: "APPETIZERS", itemType: "FOOD", price: "13.00", station: "FRY", ingredients: [oz("CALAMARI", "6"), floz("MARINARA", "2")] },
  { code: "LOADED_FRIES", name: "Loaded Fries", description: "Fries, mozzarella, bacon, jalapeños.", category: "APPETIZERS", itemType: "FOOD", price: "10.00", station: "FRY", ingredients: [oz("FRENCH_FRIES", "8"), oz("MOZZARELLA", "2"), { item: "BACON", quantity: "2", unit: "SLICE" }, oz("JALAPENOS", "0.5")] },
  { code: "BRUSCHETTA", name: "Bruschetta", description: "Toasted baguette, tomato, basil, garlic oil.", category: "APPETIZERS", itemType: "FOOD", price: "9.00", station: "SALAD", ingredients: [each("BAGUETTE", "0.5"), oz("ROMA_TOMATO", "3"), oz("FRESH_BASIL", "0.1"), floz("GARLIC_OIL", "0.5")] },
  // Salads (the add-ons group adds chicken; croutons can come off).
  { code: "CAESAR_SALAD", name: "Caesar Salad", description: "Romaine, parmesan, croutons, Caesar dressing.", category: "SALADS", itemType: "FOOD", price: "10.00", station: "SALAD", ingredients: [oz("ROMAINE", "5"), floz("CAESAR_DRESSING", "2"), oz("CROUTONS", "1"), oz("PARMESAN", "0.5")], groups: ["SALAD_ADDS"] },
  { code: "GARDEN_SALAD", name: "Garden Salad", description: "Mixed greens, tomato, peppers, onion, croutons, Italian dressing.", category: "SALADS", itemType: "FOOD", price: "8.00", station: "SALAD", ingredients: [oz("MIXED_GREENS", "4"), oz("ROMA_TOMATO", "1"), oz("GREEN_PEPPER", "0.5"), oz("YELLOW_ONION", "0.25"), oz("CROUTONS", "0.75"), floz("ITALIAN_DRESSING", "2")], groups: ["SALAD_ADDS"] },
  { code: "ANTIPASTO_SALAD", name: "Antipasto Salad", description: "Romaine, salami, capicola, provolone, olives, Italian dressing.", category: "SALADS", itemType: "FOOD", price: "13.00", station: "SALAD", ingredients: [oz("ROMAINE", "4"), oz("SALAMI", "1.5"), oz("CAPICOLA", "1.5"), { item: "PROVOLONE", quantity: "2", unit: "SLICE" }, oz("BLACK_OLIVES", "0.5"), floz("ITALIAN_DRESSING", "2")], groups: ["SALAD_ADDS"] },
  // Desserts
  { code: "CANNOLI", name: "Cannoli", description: "Two cannoli, sweet ricotta filling.", category: "DESSERTS", itemType: "FOOD", price: "7.00", station: "SALAD", ingredients: [each("CANNOLI", "2")] },
  { code: "TIRAMISU", name: "Tiramisu", description: "Espresso-soaked ladyfingers, mascarpone.", category: "DESSERTS", itemType: "FOOD", price: "8.00", station: "SALAD", ingredients: [each("TIRAMISU", "1")] },
  // Beer (House IPA comes from the burger kitchen)
  bar("DRAFT_LAGER", "Draft Lager", "16 oz pour.", "BEER", "5.50", [floz("DRAFT_LAGER", "16")]),
  bar("SEASONAL_DRAFT", "Seasonal Draft", "Ask about this month's tap.", "BEER", "7.00", [floz("SEASONAL_ALE", "16")]),
  bar("DOMESTIC_BOTTLE", "Domestic Bottle", "Bud Light, Miller Lite or Coors Light.", "BEER", "4.50", [each("DOMESTIC_BOTTLE", "1")]),
  bar("IMPORT_BOTTLE", "Import Bottle", "Peroni, Moretti or Corona.", "BEER", "6.00", [each("IMPORT_BOTTLE", "1")]),
  // Wine by the glass (6 oz)
  bar("CHIANTI_GLASS", "Chianti", "Glass, Tuscany.", "WINE", "10.00", [ml("CHIANTI", "175")]),
  bar("PINOT_GRIGIO_GLASS", "Pinot Grigio", "Glass, Veneto.", "WINE", "9.00", [ml("PINOT_GRIGIO", "175")]),
  bar("CABERNET_GLASS", "Cabernet Sauvignon", "Glass, California.", "WINE", "11.00", [ml("CABERNET", "175")]),
  bar("PROSECCO_GLASS", "Prosecco", "Glass, Veneto.", "WINE", "10.00", [ml("PROSECCO", "150")]),
  // Cocktails (Tito's Gimlet comes from the burger kitchen)
  bar("MARGARITA", "Margarita", "Tequila, triple sec, fresh lime.", "COCKTAILS", "10.00", [ml("TEQUILA_BLANCO", "45"), ml("TRIPLE_SEC", "30"), floz("LIME_JUICE", "0.75")]),
  bar("OLD_FASHIONED", "Old Fashioned", "Bourbon, sugar, bitters.", "COCKTAILS", "12.00", [ml("BOURBON", "60"), floz("SIMPLE_SYRUP", "0.25"), ml("ANGOSTURA_BITTERS", "2")]),
  bar("NEGRONI", "Negroni", "Gin, Campari, sweet vermouth.", "COCKTAILS", "12.00", [ml("GIN", "30"), ml("CAMPARI", "30"), ml("SWEET_VERMOUTH", "30")]),
  bar("APEROL_SPRITZ", "Aperol Spritz", "Aperol and prosecco.", "COCKTAILS", "11.00", [ml("APEROL", "60"), ml("PROSECCO", "90")]),
  bar("MOSCOW_MULE", "Moscow Mule", "Vodka, ginger beer, lime.", "COCKTAILS", "10.00", [ml("WELL_VODKA", "45"), each("GINGER_BEER", "1"), floz("LIME_JUICE", "0.5")]),
  bar("ESPRESSO_MARTINI", "Espresso Martini", "Vodka, coffee liqueur, cold brew.", "COCKTAILS", "13.00", [ml("WELL_VODKA", "45"), ml("COFFEE_LIQUEUR", "20"), floz("COLD_BREW", "1")]),
  // Spirits: a well pour, or a call pour for $3 more.
  bar("WHISKEY_POUR", "Whiskey", "2 oz, neat or on the rocks.", "SPIRITS", "8.00", [ml("WELL_WHISKEY", "60")], ["POUR_TIER"]),
  bar("VODKA_POUR", "Vodka", "2 oz, neat, on the rocks or with a mixer.", "SPIRITS", "7.00", [ml("WELL_VODKA", "60")], ["POUR_TIER"]),
  // Non-alcoholic
  bar("FOUNTAIN_SODA", "Fountain Soda", "Free refills.", "NON_ALCOHOLIC", "2.75", [floz("SODA_SYRUP", "2")]),
  bar("ICED_TEA", "Iced Tea", "Fresh brewed, unsweetened.", "NON_ALCOHOLIC", "2.75", [floz("ICED_TEA_BREW", "12")]),
  bar("LEMONADE", "Lemonade", "House lemonade.", "NON_ALCOHOLIC", "3.25", [floz("LEMONADE_MIX", "12")]),
  bar("ITALIAN_SODA", "Italian Soda", "Sparkling water with raspberry or vanilla syrup.", "NON_ALCOHOLIC", "3.75", [floz("ITALIAN_SODA_SYRUP", "1.5")]),
];

/** The burger kitchen's items, part of this menu (seeded by scripts/demo-kitchen.ts). */
export const BURGER_KITCHEN_ITEMS = ["BACON_CHEESEBURGER", "FRENCH_FRIES", "BUFFALO_WINGS", "TITOS_GIMLET", "HOUSE_IPA"] as const;

export type PizzaEffect =
  | { type: "ADD"; item: string; quantity: string; unit: string }
  | { type: "REMOVE"; item: string };

export type PizzaModifier = {
  code: string;
  name: string;
  price: string;
  /**
   * Inventory effects. `perRecipe` adds only for ingredients the dish's recipe already has
   * (size scales what is there); `always` adds whatever the dish. A REMOVE needs the ingredient
   * in the recipe, so it is skipped where the recipe doesn't have it.
   */
  effects: { always?: PizzaEffect[]; perRecipe?: PizzaEffect[] };
};

export type PizzaGroup = {
  code: string;
  name: string;
  selectionType: "OPTIONAL_SINGLE" | "REQUIRED_SINGLE" | "OPTIONAL_MULTIPLE";
  minimumSelections: number;
  maximumSelections: number;
  modifiers: readonly PizzaModifier[];
};

const add = (item: string, quantity: string, unit = "OZ_WEIGHT"): PizzaEffect => ({ type: "ADD", item, quantity, unit });
const topping = (code: string, name: string, effect: PizzaEffect): PizzaModifier => ({ code, name, price: "1.75", effects: { always: [effect] } });

export const PIZZA_GROUPS_DATA: readonly PizzaGroup[] = [
  {
    code: "PIZZA_SIZE",
    name: "Size",
    selectionType: "REQUIRED_SINGLE",
    minimumSelections: 1,
    maximumSelections: 1,
    modifiers: [
      { code: "SIZE_10", name: '10" Small', price: "0.00", effects: {} },
      { code: "SIZE_14", name: '14" Medium', price: "5.00", effects: { perRecipe: [add("PIZZA_DOUGH", "6"), add("PIZZA_SAUCE", "2", "FL_OZ"), add("MOZZARELLA", "2.5")] } },
      { code: "SIZE_16", name: '16" Large', price: "8.00", effects: { perRecipe: [add("PIZZA_DOUGH", "10"), add("PIZZA_SAUCE", "3", "FL_OZ"), add("MOZZARELLA", "4")] } },
    ],
  },
  {
    code: "PIZZA_CRUST",
    name: "Crust",
    selectionType: "OPTIONAL_SINGLE",
    minimumSelections: 0,
    maximumSelections: 1,
    modifiers: [
      { code: "CRUST_THIN", name: "Thin and crispy", price: "0.00", effects: {} },
      { code: "CRUST_GLUTEN_FREE", name: 'Gluten-free crust (10" only)', price: "3.00", effects: { always: [add("GF_CRUST", "1", "EACH")], perRecipe: [{ type: "REMOVE", item: "PIZZA_DOUGH" }] } },
    ],
  },
  {
    code: "PIZZA_TOPPINGS",
    name: "Extra toppings",
    selectionType: "OPTIONAL_MULTIPLE",
    minimumSelections: 0,
    maximumSelections: 6,
    modifiers: [
      topping("TOP_PEPPERONI", "Pepperoni", add("PEPPERONI", "1.5")),
      topping("TOP_SAUSAGE", "Italian sausage", add("ITALIAN_SAUSAGE", "1.5")),
      topping("TOP_BACON", "Bacon", add("BACON", "2", "SLICE")),
      topping("TOP_MUSHROOM", "Mushrooms", add("MUSHROOMS", "1")),
      topping("TOP_ONION", "Onion", add("YELLOW_ONION", "1")),
      topping("TOP_GREEN_PEPPER", "Green peppers", add("GREEN_PEPPER", "1")),
      topping("TOP_BLACK_OLIVE", "Black olives", add("BLACK_OLIVES", "0.75")),
      topping("TOP_JALAPENO", "Jalapeños", add("JALAPENOS", "0.5")),
      topping("TOP_EXTRA_CHEESE", "Extra cheese", add("MOZZARELLA", "2")),
    ],
  },
  {
    code: "SANDWICH_SIDE",
    name: "Side",
    selectionType: "REQUIRED_SINGLE",
    minimumSelections: 1,
    maximumSelections: 1,
    modifiers: [
      { code: "SIDE_FRIES", name: "Fries", price: "0.00", effects: { always: [add("FRENCH_FRIES", "5")] } },
      { code: "SIDE_SALAD", name: "Side salad", price: "0.00", effects: { always: [add("MIXED_GREENS", "2"), add("ITALIAN_DRESSING", "1", "FL_OZ")] } },
      { code: "SIDE_CHIPS", name: "Kettle chips", price: "0.00", effects: { always: [add("KETTLE_CHIPS", "1", "EACH")] } },
    ],
  },
  {
    code: "SALAD_ADDS",
    name: "Salad add-ons",
    selectionType: "OPTIONAL_MULTIPLE",
    minimumSelections: 0,
    maximumSelections: 2,
    modifiers: [
      { code: "ADD_GRILLED_CHICKEN", name: "Add grilled chicken", price: "5.00", effects: { always: [add("CHICKEN_BREAST", "4")] } },
      { code: "NO_CROUTONS", name: "No croutons", price: "0.00", effects: { perRecipe: [{ type: "REMOVE", item: "CROUTONS" }] } },
    ],
  },
  {
    code: "POUR_TIER",
    name: "Pour",
    selectionType: "REQUIRED_SINGLE",
    minimumSelections: 1,
    maximumSelections: 1,
    modifiers: [
      { code: "WELL_POUR", name: "Well", price: "0.00", effects: {} },
      {
        code: "CALL_POUR",
        name: "Call (Bourbon or Tito's)",
        price: "3.00",
        effects: {
          perRecipe: [
            { type: "REMOVE", item: "WELL_WHISKEY" },
            { type: "REMOVE", item: "WELL_VODKA" },
          ],
          // Added only where the matching well spirit was removed (see scripts/demo/menu.ts).
        },
      },
    ],
  },
];

/** What a call pour puts in place of each well spirit. */
export const CALL_POUR_SWAPS: Readonly<Record<string, { item: string; quantity: string; unit: string }>> = {
  WELL_WHISKEY: { item: "BOURBON", quantity: "60", unit: "ML" },
  WELL_VODKA: { item: "TITOS_VODKA", quantity: "60", unit: "ML" },
};

/** Declared MAY_CONTAIN allergens (shared fryer and oven), since no recipe shows them. */
export const PIZZA_DECLARED_ALLERGENS = [
  { menuItem: "GARLIC_KNOTS", allergen: "MILK", kind: "MAY_CONTAIN" as const },
  { menuItem: "LOADED_FRIES", allergen: "WHEAT", kind: "MAY_CONTAIN" as const },
] as const;

export type NutritionFacts = {
  basis: string;
  calories: string;
  fatG: string;
  saturatedFatG: string;
  carbohydrateG: string;
  sugarsG: string;
  fibreG: string;
  proteinG: string;
  sodiumMg: string;
};

/** Typical published figures per `basis` base units, rounded; clearly demo data. Makes the Cheese and Pepperoni pizza and Draft Lager labels complete. */
export const PIZZA_NUTRITION: Readonly<Record<string, NutritionFacts>> = {
  PIZZA_DOUGH: { basis: "1", calories: "75", fatG: "1", saturatedFatG: "0.2", carbohydrateG: "14", sugarsG: "0.5", fibreG: "0.6", proteinG: "2.5", sodiumMg: "150" },
  PIZZA_SAUCE: { basis: "1", calories: "10", fatG: "0.3", saturatedFatG: "0", carbohydrateG: "2", sugarsG: "1.2", fibreG: "0.4", proteinG: "0.4", sodiumMg: "95" },
  MOZZARELLA: { basis: "1", calories: "85", fatG: "6.3", saturatedFatG: "3.7", carbohydrateG: "0.6", sugarsG: "0.3", fibreG: "0", proteinG: "6.3", sodiumMg: "175" },
  PEPPERONI: { basis: "1", calories: "140", fatG: "13", saturatedFatG: "5", carbohydrateG: "0", sugarsG: "0", fibreG: "0", proteinG: "6", sodiumMg: "490" },
  DRAFT_LAGER: { basis: "12", calories: "150", fatG: "0", saturatedFatG: "0", carbohydrateG: "13", sugarsG: "0", fibreG: "0", proteinG: "1.6", sodiumMg: "14" },
};

/** The weekday happy hour: bar and dine-in, 15:00 to 18:00, fixed prices. */
export const PIZZA_HAPPY_HOUR = {
  name: "Happy hour",
  daysOfWeek: [1, 2, 3, 4, 5],
  startTime: "15:00",
  endTime: "18:00",
  orderTypes: ["BAR", "DINE_IN"],
  prices: { DRAFT_LAGER: "3.50", SEASONAL_DRAFT: "5.00", CHIANTI_GLASS: "7.00", PINOT_GRIGIO_GLASS: "7.00", GARLIC_KNOTS: "4.00" } as Record<string, string>,
};
