# Demo Data: Demo Pizza Co.

`npm run db:seed:demo` turns the local development database into a working pizza restaurant: sandwiches, appetizers and a full bar, 31 staff with realistic availability, six weeks of service history, and today's service in progress. It is for local development only (loopback `DATABASE_URL`, non-production `NODE_ENV`) and runs after `bootstrap:owner`.

## Running it

Start from an empty database:

```
npm run db:reset
npm run db:seed
npm run bootstrap:owner        # interactive; you type the owner's email and password
npm run db:seed:demo           # about 30 minutes the first time, seconds after that
```

Running it again adds nothing: every step records a `seed_runs` key or checks what already exists. A rerun on a later day adds only that day's "today" (deliveries, reservations, waitlist and tables in service). It refuses a database that still has the earlier burger demo (Uptown, Fish Tacos and so on); reset first.

Gift card codes are printed once at the end, like the sale screen shows them; the database keeps only their hashes.

Everything goes through the same services the screens use, signed in as the owner, with the script's clock moved back for the history. So ledgers, snapshots, tickets, settlements, schedules and tip pools all agree, and nothing frozen is rewritten afterwards.

## The restaurant

| | |
|---|---|
| Location | MAIN, renamed **Demo Pizza Co.** (America/Detroit, business day ends 04:00) |
| Hours | Sunday to Thursday 11:00 to 22:00; Friday and Saturday 11:00 to 23:00, bar until 00:30 |
| Floor | Dining room T01 to T14 (2- to 8-tops); bar B01 to B08. Sections: Front room, Back room, Bar |
| Stations | Pizza Oven and Sandwich added to Grill, Fry, Salad, Bar and Expo |
| Tax | One category, **Sales tax (6%)**, on every item, added on top of the price. Tax is turned on at MAIN. Gift card sales are untaxed. |
| Drawers | Cash goes into the "Front counter" drawer, one session per day, when the location requires drawers |

## Menu (54 items)

- **Pizza & Calzones (oven):** Cheese, Pepperoni, Margherita, Sausage & Peppers, Supreme, Meat Lovers, BBQ Chicken, Buffalo Chicken, Garden Veggie, White, Calzone, Stromboli. Pizzas need a **Size**: 10" (base recipe), 14" (+$5) or 16" (+$8); the bigger sizes add dough, sauce and cheese. They can take a **Crust** (thin, or gluten-free +$3, which swaps the dough) and up to six **Extra toppings** at $1.75.
- **Sandwiches:** Italian Sub, Meatball Sub, Chicken Parm Sub, Philly Cheesesteak, Turkey Club, Grilled Veggie Panini, each with a required **Side** (fries, side salad or kettle chips). The **Bacon Cheeseburger** is on the menu too.
- **Appetizers:** Garlic Knots, Cheesy Bread, Mozzarella Sticks, Fried Calamari, Loaded Fries, Bruschetta, French Fries, Buffalo Wings.
- **Salads** (add chicken, no croutons): Caesar, Garden, Antipasto. **Desserts:** Cannoli, Tiramisu.
- **Bar:** draft Lager, House IPA and a Seasonal; domestic and import bottles; Chianti, Pinot Grigio, Cabernet and Prosecco by the glass; Margarita, Old Fashioned, Negroni, Aperol Spritz, Moscow Mule, Espresso Martini, Tito's Gimlet; whiskey and vodka with a **Pour** choice (well, or call for $3 more); soda, iced tea, lemonade, Italian soda.
- **Happy hour:** weekdays 15:00 to 18:00 for bar and dining room checks: Lager $3.50, Seasonal $5, Chianti and Pinot Grigio $7, Garlic Knots $4.

Every item has a published recipe. About 75 ingredients have costs, two suppliers (Demo Foods Supply and Demo Spirits & Beverage), par and reorder levels and allergen tags. The fryer and oven items declare what they may contain. The Cheese and Pepperoni pizzas and the Draft Lager have complete nutrition labels; the rest show as incomplete on purpose.

The Bacon Cheeseburger, French Fries, Buffalo Wings, Tito's Gimlet and House IPA come from the burger kitchen (`scripts/demo-kitchen.ts`) that the Phase 13 validation fixture also uses, so the canonical Bacon Cheeseburger is the same item in both.

## Staff (31, `DEMO-001` to `DEMO-031`)

General manager, two managers, an inventory manager, seven servers, four bartenders, two hosts, four pizza cooks, three line cooks, two prep cooks, two dishwashers, two bussers and a weekend expeditor. Pay is set per employee and position: tipped positions at the tipped rate, managers on salary. Several people hold a second position with its own rate (bartenders who also serve, a pizza cook who works the line, a busser who washes dishes, a line cook who expedites).

Availability varies the way it does in a real restaurant:

| Pattern | Who | Windows |
|---|---|---|
| Open | Full-timers | Any day, 07:00 to 01:30 |
| Closer | Night people | Any day, 15:00 to 01:30 |
| Opener | Day people | Any day, 07:00 to 17:30 |
| Weekday days | A parent | Monday to Friday, 08:00 to 16:00 |
| Student | Part-timers | Weeknights after 15:30; Friday to Sunday from 10:00 |
| No Sundays | One server | Sunday marked unavailable |
| Early prep | Prep cooks | 06:00 to 15:00 on their days |
| Office | The GM | Weekdays 08:00 to 18:00, Saturday lunch |

The **"Pizza week"** staffing template covers lunch and dinner for managers, servers, bartenders, a host, pizza cooks, line cooks, prep, dish, a busser and an expeditor on Friday and Saturday. The demo checks that every slot has at least one more eligible person than it needs, so **Generate** fills every shift. Staffing ratios for the demand forecast are set for servers, bartenders, hosts, pizza cooks and cooks. The tip pool shares among servers and bartenders (10 points) and bussers (4).

Food safety and alcohol service certifications are recorded. One expired 12 days ago, two expire within 30 days (warnings), and the rest are current.

Next week: one approved vacation (Jasmine Cole, Tuesday to Thursday; the generator leaves her off) and one personal day still waiting for a manager (Chloe Martin, Saturday).

## Six weeks of history

- **Schedules:** each week generated from "Pizza week" and published before it starts. Next week is a draft for you to review and publish.
- **Service:** 18 to 37 checks a day (about 1,080 over six weeks), busiest on Friday and Saturday. Dine-in is rung by seat, and about a third of tables are coursed (starters first, mains fired after). There are bar tabs, and takeout makes up about a third of checks. A few voids before the kitchen starts, a manager comp now and then, and a school fundraiser table each Wednesday marked tax exempt. Cash and card with tips. Kitchen and bar tickets are worked through to completed, and tables are cleaned after each party. Some dinner parties come from reservations linked to guest profiles.
- **Stock:** a purchase order per supplier received each week, sized to the week's sales. A Monday count of the cheese, proteins and dough (mozzarella and pepperoni come up a little short). Dough and greens are thrown out on Sunday night.
- **Labor and tips:** every shift is punched a few minutes either side. The busiest person in the third week works overtime. The last shift that ended yesterday has no clock-out (the missed clock-out demo). Bartenders declare cash tips for the last two weeks, and each day's tip pool is finalized through two days ago.

All of this feeds the reports (sales, tax, item mix, menu engineering, labor, tips, voids and comps, accounting exports), the demand and item forecasts, and the prep list.

## Today

- This morning's delivery brings every ingredient back to par, except **Fried Calamari**, which is left low so the 86 board shows it running low. Auto-86 from stock is on.
- **Tiramisu** is 86'd until close.
- Mozzarella is lot tracked, with two dated lots (one expiring in two days).
- Reservations for the next seven days (phone, plus one online booking a day), and online booking turned on for 16:30 to 20:30. Three parties are on tonight's waitlist.
- **Three tables mid-meal:** a four-top with pizzas in the oven, a two-top whose mains are held until the calamari is cleared, and a bar tab. One two-top is waiting to be cleaned.
- A server has asked to swap a shift later this week with another server; it waits for that server to accept and then for a manager.

## Guests, loyalty and gift cards

- Guest profiles: "Demo Guest Peanut" (VIP, severe peanut allergy), "Demo Guest Milk" and "Demo Guest Gluten". Loyalty is on (1 point per $1, 5 per visit) with two rewards, "Free garlic knots" and "$10 off the check". The peanut guest redeemed the knots on one visit, and part of that check was later refunded, taking back points.
- Gift cards are on. Cards were sold, one reloaded and one partly spent; one has a supplier's printed code; one has been unused for 40 months (with purchaser details); one was reported as unclaimed. A box of 10 printed stock cards (`DEMOSTK0001` to `DEMOSTK0010`) is registered: 2 sold, 1 deactivated.
- To try an erase: Dana Whitfield has a profile and is named in a takeout check, its instruction, a draft shift note and tonight's waitlist.
- The manager log has five entries (one a correction), and there are three pre-shift notes.

## Files

| File | Holds |
|---|---|
| `src/db/demo/pizza/*.ts` | The data: restaurant, staff, menu, guests |
| `scripts/seed-demo.ts` | The order of the steps and the summary it prints |
| `scripts/demo/*.ts` | One step each: restaurant, staff, menu, history, live, loyalty, gift cards, follow-ups, unclaimed and erase, briefings |
| `scripts/demo-kitchen.ts`, `src/db/demo/demo-kitchen.ts` | The burger kitchen, shared with `db:seed:validation` |
| `scripts/demo-guests-allergens.ts` | Allergen tagging and guest profiles, shared with `db:seed:validation` |
