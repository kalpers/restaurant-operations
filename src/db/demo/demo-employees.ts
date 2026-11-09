/**
 * Demo roster for local development. It is opt-in (`npm run db:seed:demo`) and never part
 * of the baseline seeds, which create no employee records. Every employee number starts
 * with `DEMO-`, which is how reruns find what already exists.
 */

export type DemoWage =
  | { type: "HOURLY"; hourlyRate: string }
  | { type: "SALARY"; annualSalary: string };

export type DemoEmployee = {
  employeeNumber: string;
  firstName: string;
  lastName: string;
  preferredName?: string;
  employmentType: "FULL_TIME" | "PART_TIME";
  hireDate: string;
  phone: string;
  position: { code: string; wage: DemoWage };
  /** A second position held from a later date, with its own wage. */
  secondary?: { code: string; effectiveFrom: string; wage: DemoWage };
};

/** Positions beyond the baseline eight. Jobs only: they grant no permissions. */
export const DEMO_POSITIONS = [
  { code: "BUSSER", name: "Busser", description: "Clears and resets tables." },
  { code: "DISHWASHER", name: "Dishwasher", description: "Runs the dish station." },
  { code: "EXPEDITOR", name: "Expeditor", description: "Checks and passes plates from the kitchen." },
] as const;

/**
 * Recurring availability every demo employee gets, so Scheduling has someone to assign:
 * every day (0 = Sunday), 06:00 to 03:00 the next morning, at every location, from the hire
 * date with no end. A window whose end is before its start runs overnight, so this covers
 * opening, mid and closing shifts, including closes after midnight. Edit it per employee
 * on the Availability page to make the roster more realistic.
 */
export const DEMO_AVAILABILITY = {
  daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
  startTime: "06:00",
  endTime: "03:00",
} as const;

const hourly = (hourlyRate: string): DemoWage => ({ type: "HOURLY", hourlyRate });
const salary = (annualSalary: string): DemoWage => ({ type: "SALARY", annualSalary });

export const DEMO_EMPLOYEES: readonly DemoEmployee[] = [
  {
    employeeNumber: "DEMO-001",
    firstName: "Morgan",
    lastName: "Reyes",
    employmentType: "FULL_TIME",
    hireDate: "2022-03-14",
    phone: "555-0101",
    position: { code: "GENERAL_MANAGER", wage: salary("82000.00") },
  },
  {
    employeeNumber: "DEMO-002",
    firstName: "Priya",
    lastName: "Nair",
    employmentType: "FULL_TIME",
    hireDate: "2022-09-06",
    phone: "555-0102",
    position: { code: "MANAGER", wage: salary("64000.00") },
  },
  {
    employeeNumber: "DEMO-003",
    firstName: "Alex",
    lastName: "Chen",
    employmentType: "FULL_TIME",
    hireDate: "2023-01-23",
    phone: "555-0103",
    position: { code: "SERVER", wage: hourly("12.50") },
  },
  {
    employeeNumber: "DEMO-004",
    firstName: "Jordan",
    lastName: "Patel",
    employmentType: "FULL_TIME",
    hireDate: "2023-05-08",
    phone: "555-0104",
    position: { code: "SERVER", wage: hourly("12.50") },
  },
  {
    employeeNumber: "DEMO-005",
    firstName: "Taylor",
    lastName: "Okafor",
    employmentType: "PART_TIME",
    hireDate: "2024-02-12",
    phone: "555-0105",
    position: { code: "SERVER", wage: hourly("11.75") },
  },
  {
    employeeNumber: "DEMO-006",
    firstName: "Sam",
    lastName: "Rivera",
    employmentType: "PART_TIME",
    hireDate: "2024-08-19",
    phone: "555-0106",
    position: { code: "SERVER", wage: hourly("11.75") },
  },
  {
    employeeNumber: "DEMO-007",
    firstName: "Casey",
    lastName: "Lindqvist",
    employmentType: "FULL_TIME",
    hireDate: "2022-11-28",
    phone: "555-0107",
    position: { code: "BARTENDER", wage: hourly("14.00") },
    secondary: { code: "SERVER", effectiveFrom: "2024-03-01", wage: hourly("12.50") },
  },
  {
    employeeNumber: "DEMO-008",
    firstName: "Riley",
    lastName: "Moreau",
    employmentType: "PART_TIME",
    hireDate: "2024-06-03",
    phone: "555-0108",
    position: { code: "BARTENDER", wage: hourly("13.50") },
  },
  {
    employeeNumber: "DEMO-009",
    firstName: "Jamie",
    lastName: "Alvarez",
    employmentType: "PART_TIME",
    hireDate: "2024-09-16",
    phone: "555-0109",
    position: { code: "HOST", wage: hourly("14.00") },
  },
  {
    employeeNumber: "DEMO-010",
    firstName: "Avery",
    lastName: "Kim",
    employmentType: "PART_TIME",
    hireDate: "2025-01-13",
    phone: "555-0110",
    position: { code: "HOST", wage: hourly("14.00") },
  },
  {
    employeeNumber: "DEMO-011",
    firstName: "Marco",
    lastName: "Bellini",
    employmentType: "FULL_TIME",
    hireDate: "2022-05-02",
    phone: "555-0111",
    position: { code: "COOK", wage: hourly("23.00") },
    secondary: { code: "EXPEDITOR", effectiveFrom: "2024-01-08", wage: hourly("19.00") },
  },
  {
    employeeNumber: "DEMO-012",
    firstName: "Dana",
    lastName: "Whitfield",
    employmentType: "FULL_TIME",
    hireDate: "2023-07-17",
    phone: "555-0112",
    position: { code: "COOK", wage: hourly("21.50") },
  },
  {
    employeeNumber: "DEMO-013",
    firstName: "Luis",
    lastName: "Herrera",
    employmentType: "PART_TIME",
    hireDate: "2024-04-22",
    phone: "555-0113",
    position: { code: "COOK", wage: hourly("19.50") },
    secondary: { code: "DISHWASHER", effectiveFrom: "2024-10-01", wage: hourly("16.00") },
  },
  {
    employeeNumber: "DEMO-014",
    firstName: "Noor",
    lastName: "Haddad",
    employmentType: "PART_TIME",
    hireDate: "2024-10-07",
    phone: "555-0114",
    position: { code: "WAIT_STAFF", wage: hourly("11.50") },
  },
  {
    employeeNumber: "DEMO-015",
    firstName: "Eli",
    lastName: "Johansson",
    employmentType: "PART_TIME",
    hireDate: "2025-02-24",
    phone: "555-0115",
    position: { code: "WAIT_STAFF", wage: hourly("11.50") },
  },
  {
    employeeNumber: "DEMO-016",
    firstName: "Tomás",
    lastName: "Ruiz",
    employmentType: "PART_TIME",
    hireDate: "2025-03-10",
    phone: "555-0116",
    position: { code: "BUSSER", wage: hourly("11.00") },
  },
  {
    employeeNumber: "DEMO-017",
    firstName: "Greta",
    lastName: "Sørensen",
    employmentType: "FULL_TIME",
    hireDate: "2023-03-06",
    phone: "555-0117",
    position: { code: "INVENTORY_MANAGER", wage: hourly("25.00") },
  },
];
