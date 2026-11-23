/**
 * The demo pizza restaurant's staff: positions, a roster of 31 with pay per
 * employee and position, recurring availability patterns, the weekly staffing template, the
 * staffing ratios for the demand forecast, and certifications. Data only; `scripts/demo/staff.ts`
 * writes it through the services. Every employee number starts with `DEMO-`, which is how reruns
 * find what already exists.
 *
 * Availability is varied on purpose (students, parents, closers, openers, one who never works
 * Sundays), but every template slot has at least one more eligible person than it needs, and each
 * day can be staffed with one shift per person, which the staff step checks, so "Generate
 * schedule" fills every shift.
 */

export type DemoWage = { type: "HOURLY"; hourlyRate: string } | { type: "SALARY"; annualSalary: string };

/** Day of week: 0 = Sunday. A window whose end is at or before its start runs past midnight. */
export type AvailabilityWindow = { days: readonly number[]; start: string; end: string; type?: "AVAILABLE" | "UNAVAILABLE" };

const ALL = [0, 1, 2, 3, 4, 5, 6] as const;
const WEEKDAYS = [1, 2, 3, 4, 5] as const;

/** Named patterns, so the roster reads like a manager's notes. */
export const AVAILABILITY_PATTERNS = {
  /** Full-timer: any shift, any day. */
  OPEN: [{ days: ALL, start: "07:00", end: "01:30" }],
  /** Afternoons and nights only. */
  CLOSER: [{ days: ALL, start: "15:00", end: "01:30" }],
  /** Mornings and early afternoons. */
  OPENER: [{ days: ALL, start: "07:00", end: "17:30" }],
  /** A parent: weekday daytime only. */
  WEEKDAY_DAYS: [{ days: WEEKDAYS, start: "08:00", end: "16:00" }],
  /** A student: weeknight evenings after class, long weekends. */
  STUDENT: [
    { days: [1, 2, 3, 4], start: "15:30", end: "23:30" },
    { days: [5, 6], start: "10:00", end: "01:30" },
    { days: [0], start: "10:00", end: "23:30" },
  ],
  /** Anything but Sunday, which is marked unavailable. */
  NO_SUNDAYS: [
    { days: [1, 2, 3, 4, 5, 6], start: "09:00", end: "01:30" },
    { days: [0], start: "00:00", end: "23:59", type: "UNAVAILABLE" as const },
  ],
  /** Early prep, Monday to Friday. */
  EARLY_WEEKDAYS: [{ days: WEEKDAYS, start: "06:00", end: "15:00" }],
  /** Early prep, Wednesday to Sunday. */
  EARLY_LATE_WEEK: [{ days: [0, 3, 4, 5, 6], start: "06:00", end: "15:00" }],
  /** Office hours, Monday to Friday, plus Saturday lunch. */
  OFFICE: [
    { days: WEEKDAYS, start: "08:00", end: "18:00" },
    { days: [6], start: "10:00", end: "16:00" },
  ],
  /** Wednesday to Sunday, any time. */
  LATE_WEEK: [{ days: [0, 3, 4, 5, 6], start: "09:00", end: "01:30" }],
  /** Tuesday off (marked), otherwise evenings. */
  EVENINGS_NOT_TUESDAY: [
    { days: [0, 1, 3, 4, 5, 6], start: "15:00", end: "01:30" },
    { days: [2], start: "00:00", end: "23:59", type: "UNAVAILABLE" as const },
  ],
} satisfies Record<string, readonly AvailabilityWindow[]>;

export type AvailabilityPattern = keyof typeof AVAILABILITY_PATTERNS;

/** Positions beyond the baseline eight. Jobs only: they grant no permissions. */
export const PIZZA_POSITIONS = [
  { code: "BUSSER", name: "Busser", description: "Clears and resets tables." },
  { code: "DISHWASHER", name: "Dishwasher", description: "Runs the dish station." },
  { code: "EXPEDITOR", name: "Expeditor", description: "Checks and passes plates from the kitchen." },
  { code: "PIZZA_COOK", name: "Pizza Cook", description: "Stretches, tops and bakes pizzas, calzones and knots." },
  { code: "PREP_COOK", name: "Prep Cook", description: "Morning prep: dough, sauce, slicing and portioning." },
] as const;

export type PizzaEmployee = {
  employeeNumber: string;
  firstName: string;
  lastName: string;
  preferredName?: string;
  employmentType: "FULL_TIME" | "PART_TIME";
  hireDate: string;
  phone: string;
  position: { code: string; wage: DemoWage };
  /** Further positions held from a date, each with its own wage. */
  secondary?: readonly { code: string; effectiveFrom: string; wage: DemoWage }[];
  availability: AvailabilityPattern;
  /** Certifications held; `expiresInDays` is counted from the day the demo runs. */
  certifications?: readonly { type: "FOOD_SAFETY" | "ALCOHOL_SERVICE"; expiresInDays: number }[];
};

const hourly = (hourlyRate: string): DemoWage => ({ type: "HOURLY", hourlyRate });
const salary = (annualSalary: string): DemoWage => ({ type: "SALARY", annualSalary });
const FOOD = (days: number) => ({ type: "FOOD_SAFETY" as const, expiresInDays: days });
const ALCOHOL = (days: number) => ({ type: "ALCOHOL_SERVICE" as const, expiresInDays: days });

let phone = 100;
const person = (
  number: number,
  firstName: string,
  lastName: string,
  employmentType: PizzaEmployee["employmentType"],
  hireDate: string,
  position: PizzaEmployee["position"],
  availability: AvailabilityPattern,
  extra: Partial<Pick<PizzaEmployee, "preferredName" | "secondary" | "certifications">> = {},
): PizzaEmployee => ({
  employeeNumber: `DEMO-${String(number).padStart(3, "0")}`,
  firstName,
  lastName,
  employmentType,
  hireDate,
  phone: `555-0${String((phone += 1)).padStart(3, "0")}`,
  position,
  availability,
  ...extra,
});

export const PIZZA_EMPLOYEES: readonly PizzaEmployee[] = [
  // Management
  person(1, "Morgan", "Reyes", "FULL_TIME", "2021-03-14", { code: "GENERAL_MANAGER", wage: salary("78000.00") }, "OFFICE", {
    secondary: [{ code: "MANAGER", effectiveFrom: "2021-03-14", wage: salary("78000.00") }],
    certifications: [FOOD(400), ALCOHOL(300)],
  }),
  person(2, "Priya", "Nair", "FULL_TIME", "2022-05-02", { code: "MANAGER", wage: salary("62000.00") }, "OPEN", { certifications: [FOOD(250), ALCOHOL(500)] }),
  person(3, "Marcus", "Bell", "FULL_TIME", "2023-01-09", { code: "MANAGER", wage: salary("58000.00") }, "OPEN", { certifications: [FOOD(610), ALCOHOL(180)] }),
  person(4, "Elena", "Russo", "FULL_TIME", "2022-08-22", { code: "INVENTORY_MANAGER", wage: salary("52000.00") }, "LATE_WEEK", {
    secondary: [
      { code: "MANAGER", effectiveFrom: "2024-02-01", wage: salary("52000.00") },
      { code: "EXPEDITOR", effectiveFrom: "2024-02-01", wage: salary("52000.00") },
    ],
    certifications: [FOOD(90)],
  }),
  // Servers
  person(5, "Jasmine", "Cole", "FULL_TIME", "2022-10-03", { code: "SERVER", wage: hourly("4.40") }, "OPEN", { certifications: [ALCOHOL(365)] }),
  person(6, "Tyler", "Brooks", "FULL_TIME", "2023-04-17", { code: "SERVER", wage: hourly("4.40") }, "OPEN", { certifications: [ALCOHOL(22)] }),
  person(7, "Hannah", "Kim", "PART_TIME", "2024-06-10", { code: "SERVER", wage: hourly("4.40") }, "WEEKDAY_DAYS", { certifications: [ALCOHOL(700)] }),
  person(8, "Diego", "Alvarez", "PART_TIME", "2024-09-03", { code: "SERVER", wage: hourly("4.40") }, "STUDENT"),
  person(9, "Olivia", "Grant", "PART_TIME", "2025-01-20", { code: "SERVER", wage: hourly("4.40") }, "STUDENT"),
  person(10, "Samuel", "Osei", "FULL_TIME", "2023-11-06", { code: "SERVER", wage: hourly("4.40") }, "CLOSER", {
    preferredName: "Sam",
    secondary: [{ code: "EXPEDITOR", effectiveFrom: "2024-05-01", wage: hourly("15.00") }],
  }),
  person(11, "Grace", "Lindholm", "FULL_TIME", "2022-02-14", { code: "SERVER", wage: hourly("4.40") }, "NO_SUNDAYS", { certifications: [ALCOHOL(140)] }),
  // Bartenders
  person(12, "Andre", "Lewis", "FULL_TIME", "2021-07-19", { code: "BARTENDER", wage: hourly("6.50") }, "OPEN", { certifications: [ALCOHOL(420)] }),
  person(13, "Chloe", "Martin", "FULL_TIME", "2023-03-27", { code: "BARTENDER", wage: hourly("6.50") }, "CLOSER", {
    secondary: [{ code: "SERVER", effectiveFrom: "2023-03-27", wage: hourly("4.40") }],
    certifications: [ALCOHOL(260)],
  }),
  person(14, "Nico", "Ferraro", "PART_TIME", "2024-04-08", { code: "BARTENDER", wage: hourly("6.50") }, "OPENER", {
    secondary: [{ code: "SERVER", effectiveFrom: "2024-04-08", wage: hourly("4.40") }],
    certifications: [ALCOHOL(330)],
  }),
  person(15, "Riley", "Shaw", "PART_TIME", "2025-03-03", { code: "BARTENDER", wage: hourly("6.50") }, "STUDENT", { certifications: [ALCOHOL(600)] }),
  // Hosts
  person(16, "Ava", "Turner", "PART_TIME", "2024-08-12", { code: "HOST", wage: hourly("13.00") }, "CLOSER"),
  person(17, "Leo", "Park", "PART_TIME", "2025-02-17", { code: "HOST", wage: hourly("13.00") }, "STUDENT"),
  // Pizza cooks
  person(18, "Tony", "DeLuca", "FULL_TIME", "2020-09-01", { code: "PIZZA_COOK", wage: hourly("19.50") }, "OPEN", {
    preferredName: "Tony",
    certifications: [FOOD(510)],
  }),
  person(19, "Maria", "Santos", "FULL_TIME", "2022-06-13", { code: "PIZZA_COOK", wage: hourly("18.00") }, "OPEN", { certifications: [FOOD(20)] }),
  person(20, "Kevin", "O'Neill", "FULL_TIME", "2023-08-28", { code: "PIZZA_COOK", wage: hourly("17.25") }, "CLOSER", {
    secondary: [{ code: "COOK", effectiveFrom: "2024-01-15", wage: hourly("17.25") }],
    certifications: [FOOD(300)],
  }),
  person(21, "Aisha", "Rahman", "PART_TIME", "2024-10-07", { code: "PIZZA_COOK", wage: hourly("16.50") }, "OPENER", { certifications: [FOOD(680)] }),
  // Line cooks (sandwiches, fryer, salads)
  person(22, "Carlos", "Mendez", "FULL_TIME", "2021-11-15", { code: "COOK", wage: hourly("19.00") }, "OPEN", {
    secondary: [{ code: "EXPEDITOR", effectiveFrom: "2023-06-01", wage: hourly("19.00") }],
    certifications: [FOOD(150)],
  }),
  person(23, "Brianna", "Wells", "FULL_TIME", "2023-05-22", { code: "COOK", wage: hourly("17.50") }, "CLOSER", { certifications: [FOOD(-12)] }),
  person(24, "Jamal", "Carter", "FULL_TIME", "2024-02-26", { code: "COOK", wage: hourly("17.00") }, "OPENER", {
    secondary: [{ code: "PREP_COOK", effectiveFrom: "2024-02-26", wage: hourly("16.00") }],
    certifications: [FOOD(420)],
  }),
  // Prep cooks
  person(25, "Rosa", "Lopez", "FULL_TIME", "2022-12-05", { code: "PREP_COOK", wage: hourly("16.00") }, "EARLY_WEEKDAYS", { certifications: [FOOD(230)] }),
  person(26, "Ethan", "Moore", "PART_TIME", "2025-04-14", { code: "PREP_COOK", wage: hourly("15.50") }, "EARLY_LATE_WEEK"),
  // Dish and bussers
  person(27, "Luis", "Ortega", "FULL_TIME", "2023-07-10", { code: "DISHWASHER", wage: hourly("14.25") }, "EVENINGS_NOT_TUESDAY"),
  person(28, "Mia", "Johnson", "PART_TIME", "2025-05-05", { code: "DISHWASHER", wage: hourly("14.00") }, "STUDENT", {
    secondary: [{ code: "BUSSER", effectiveFrom: "2025-05-05", wage: hourly("9.00") }],
  }),
  person(29, "Owen", "Price", "PART_TIME", "2024-11-18", { code: "BUSSER", wage: hourly("9.00") }, "STUDENT", {
    secondary: [{ code: "DISHWASHER", effectiveFrom: "2025-01-06", wage: hourly("14.00") }],
  }),
  person(30, "Zoe", "Adams", "PART_TIME", "2025-06-02", { code: "BUSSER", wage: hourly("9.00") }, "CLOSER", {
    secondary: [{ code: "EXPEDITOR", effectiveFrom: "2025-06-02", wage: hourly("15.00") }],
  }),
  // The weekend expeditor, who also buses when the pass is quiet.
  person(31, "Isaac", "Bennett", "PART_TIME", "2025-03-17", { code: "EXPEDITOR", wage: hourly("15.00") }, "STUDENT", {
    secondary: [{ code: "BUSSER", effectiveFrom: "2025-03-17", wage: hourly("9.00") }],
  }),
];

export type StaffingRequirement = { position: string; days: readonly number[]; start: string; end: string; count: number };

const SUN_THU = [0, 1, 2, 3, 4] as const;
const FRI_SAT = [5, 6] as const;

/**
 * "Pizza week": open 11:00 to 22:00 Sunday to Thursday, 11:00 to 23:00 Friday and Saturday,
 * with the bar until 00:30 on Friday and Saturday nights.
 */
export const PIZZA_WEEK: readonly StaffingRequirement[] = [
  { position: "MANAGER", days: ALL, start: "10:00", end: "17:00", count: 1 },
  { position: "MANAGER", days: SUN_THU, start: "16:30", end: "22:30", count: 1 },
  { position: "MANAGER", days: FRI_SAT, start: "16:30", end: "00:30", count: 1 },
  { position: "SERVER", days: ALL, start: "10:45", end: "15:00", count: 2 },
  { position: "SERVER", days: SUN_THU, start: "16:00", end: "22:00", count: 3 },
  { position: "SERVER", days: FRI_SAT, start: "16:00", end: "23:00", count: 4 },
  { position: "BARTENDER", days: ALL, start: "11:00", end: "17:00", count: 1 },
  { position: "BARTENDER", days: SUN_THU, start: "16:30", end: "22:30", count: 1 },
  { position: "BARTENDER", days: FRI_SAT, start: "16:30", end: "00:30", count: 2 },
  { position: "HOST", days: SUN_THU, start: "17:00", end: "21:30", count: 1 },
  { position: "HOST", days: FRI_SAT, start: "17:00", end: "22:00", count: 1 },
  { position: "PIZZA_COOK", days: ALL, start: "10:00", end: "16:00", count: 1 },
  { position: "PIZZA_COOK", days: SUN_THU, start: "15:30", end: "22:30", count: 2 },
  { position: "PIZZA_COOK", days: FRI_SAT, start: "15:30", end: "23:30", count: 2 },
  { position: "COOK", days: ALL, start: "10:30", end: "16:00", count: 1 },
  { position: "COOK", days: SUN_THU, start: "16:00", end: "22:30", count: 1 },
  { position: "COOK", days: FRI_SAT, start: "16:00", end: "23:30", count: 2 },
  { position: "PREP_COOK", days: [1, 2, 3, 4, 5, 6], start: "08:00", end: "14:00", count: 1 },
  { position: "DISHWASHER", days: SUN_THU, start: "16:00", end: "23:00", count: 1 },
  { position: "DISHWASHER", days: FRI_SAT, start: "16:00", end: "00:30", count: 1 },
  { position: "BUSSER", days: FRI_SAT, start: "17:00", end: "22:30", count: 1 },
  { position: "EXPEDITOR", days: FRI_SAT, start: "17:00", end: "22:00", count: 1 },
];

/** Demand forecast ratios (Phase 24): how many of each position the busiest hour calls for. */
export const PIZZA_RATIOS = [
  { positionCode: "SERVER", measure: "DINING_COVERS", unitsPerEmployeeHour: "10", minimumEmployees: 2, maximumEmployees: 6 },
  { positionCode: "BARTENDER", measure: "BAR_CHECKS", unitsPerEmployeeHour: "6", minimumEmployees: 1, maximumEmployees: 3 },
  { positionCode: "HOST", measure: "DINING_COVERS", unitsPerEmployeeHour: "30", minimumEmployees: 1, maximumEmployees: 2 },
  { positionCode: "PIZZA_COOK", measure: "ALL_CHECKS", unitsPerEmployeeHour: "6", minimumEmployees: 1, maximumEmployees: 4 },
  { positionCode: "COOK", measure: "ALL_CHECKS", unitsPerEmployeeHour: "10", minimumEmployees: 1, maximumEmployees: 3 },
] as const;

/** The tip pool: front of house shares by hours worked times points. */
export const PIZZA_TIP_POOL = [
  { position: "SERVER", points: "10" },
  { position: "BARTENDER", points: "10" },
  { position: "BUSSER", points: "4" },
] as const;

/**
 * Time off, counted in days from the start of next week (a Sunday): one approved vacation the
 * generator works around, one request still waiting for a manager.
 */
export const PIZZA_TIME_OFF = [
  { employeeNumber: "DEMO-005", fromDay: 2, toDay: 4, requestType: "VACATION" as const, reason: "Family trip", approve: true },
  { employeeNumber: "DEMO-013", fromDay: 6, toDay: 6, requestType: "PERSONAL" as const, reason: "Sister's wedding", approve: false },
] as const;
