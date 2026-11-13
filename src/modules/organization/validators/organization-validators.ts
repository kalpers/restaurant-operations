import { z } from "zod";

const expectedVersion = z.int().positive();
const optionalText = z.string().trim().max(200).nullable();
const optionalEmail = z.email().max(320).nullable();

const timezone = z.string().refine((value) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
});

/** `active` isn't editable here: deactivating these would lock out their users. */
export const updateOrganizationSchema = z.object({
  name: z.string().trim().min(1).max(200),
  legalName: optionalText,
  phone: optionalText,
  email: optionalEmail,
  defaultTimezone: timezone,
  defaultCurrency: z.string().regex(/^[A-Z]{3}$/),
  expectedVersion,
});

export const updateLocationSchema = z.object({
  name: z.string().trim().min(1).max(200),
  addressLine1: optionalText,
  addressLine2: optionalText,
  city: optionalText,
  state: optionalText,
  postalCode: optionalText,
  country: z.string().regex(/^[A-Z]{2}$/),
  phone: optionalText,
  email: optionalEmail,
  timezone,
  expectedVersion,
});

const positiveMinutes = z.int().positive().max(1440);

export const updateLocationSettingsSchema = z.object({
  businessDayCutoff: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/),
  defaultTableTurnMinutes: positiveMinutes,
  defaultReservationDurationMinutes: positiveMinutes,
  defaultWaitQuoteMinutes: positiveMinutes,
  allowWalkIns: z.boolean(),
  allowReservations: z.boolean(),
  allowTakeout: z.boolean(),
  inventoryEnabled: z.boolean(),
  schedulingEnabled: z.boolean(),
  kitchenDisplayEnabled: z.boolean(),
  /** Phase 23 (policy 22): days of warning before a lot expires; 0 turns warnings off. */
  lotExpiryWarningDays: z.int().min(0).max(30).optional(),
  expectedVersion,
});

export const updateAreaSchema = z.object({
  name: z.string().trim().min(1).max(100),
  displayOrder: z.int().min(0).max(1000),
  active: z.boolean(),
});

export const locationIdParamsSchema = z.object({ locationId: z.uuid() });
export const areaIdParamsSchema = z.object({ areaId: z.uuid() });

/** Phase 23 (policies 1–2): the copy groups, as `src/workflows/open-location` lists them. */
const COPY_GROUP_VALUES = [
  "SETTINGS",
  "STATIONS_AND_ROUTING",
  "MENUS",
  "PRICES",
  "TAX_RATES",
  "STOCKED_ITEMS",
  "SCHEDULING_RULES",
  "TIP_POOL_RULES",
  "BOOKING_HOURS",
] as const;

export const createLocationSchema = z.object({
  name: z.string().trim().min(1).max(200),
  locationCode: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(z.string().regex(/^[A-Z0-9]{2,12}$/, "Use 2 to 12 letters or digits.")),
  timezone,
  addressLine1: optionalText.default(null),
  addressLine2: optionalText.default(null),
  city: optionalText.default(null),
  state: optionalText.default(null),
  postalCode: optionalText.default(null),
  country: z.string().regex(/^[A-Z]{2}$/).default("US"),
  phone: optionalText.default(null),
  email: optionalEmail.default(null),
  copyFrom: z
    .object({
      locationId: z.uuid(),
      groups: z.array(z.enum(COPY_GROUP_VALUES)).max(COPY_GROUP_VALUES.length),
    })
    .nullable()
    .default(null),
});

export const locationLifecycleSchema = z.object({ expectedVersion });
