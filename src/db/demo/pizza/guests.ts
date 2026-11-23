/**
 * The demo pizza restaurant's regulars: guest profiles with allergies (one a VIP). Data only;
 * created through the guest profile service by `npm run db:seed:demo`. The loyalty, gift card
 * and erase demos (scripts/demo/) name these guests.
 */

export type PizzaGuest = {
  displayName: string;
  vip: boolean;
  vipReason: string | null;
  preferences: string | null;
  allergies: readonly { allergen: string; severity: "SEVERE" | "ALLERGY" }[];
};

export const PIZZA_GUESTS: readonly PizzaGuest[] = [
  {
    displayName: "Demo Guest Peanut",
    vip: true,
    vipReason: "Friday regular for ten years",
    preferences: "Booth T09, large pepperoni well done",
    allergies: [{ allergen: "PEANUTS", severity: "SEVERE" }],
  },
  {
    displayName: "Demo Guest Milk",
    vip: false,
    vipReason: null,
    preferences: "Ask for the dairy-free cheese when we carry it",
    allergies: [{ allergen: "MILK", severity: "ALLERGY" }],
  },
  {
    displayName: "Demo Guest Gluten",
    vip: false,
    vipReason: null,
    preferences: "Gluten-free crust, every time",
    allergies: [{ allergen: "WHEAT", severity: "SEVERE" }],
  },
];
