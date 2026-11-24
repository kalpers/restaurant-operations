# Restaurant Operations — User Guide

Nov 23, 2026 · @Kneale Alpers

## About this guide

This guide shows every employee what they can do in the Restaurant Operations app, from the host stand to the office. It is organized by job: read "Getting started", then the sections for the work you do.

The app runs the whole restaurant in one place: reservations and seating, orders, kitchen and bar tickets, recording payments, schedules and the time clock, menu, recipes and stock, and reports. It works in a browser on a computer, tablet or phone.

**Three things to know before you start**

- **The app records payments; it does not take them.** Cards are charged on the separate card terminal. You record in the app what the guest paid. Never type a full card number, security code, PIN or bank details anywhere.
- **What you see depends on your role.** Your *security role* (for example Server, Host, Manager) decides which pages and buttons you get. Your *position* (the job you work, such as Line Cook or Bartender) is used for schedules, tips and pre-shift notes. They are set separately, so a position never gives you extra access. If a page you need is missing, ask a manager to check your role.
- **You work at one location at a time.** The header shows your location. If you work at several, pick one from the list; everything you see and save belongs to it.

**A day of service at a glance**

1. The manager publishes the schedule; staff clock in and read the pre-shift notes.
2. The host checks in a reservation or walk-in, or adds the party to the waitlist.
3. The host seats the party at a table. This starts a *table session*.
4. The server opens a check, adds drinks and food and presses **Send**.
5. The bar and kitchen work the tickets and mark them **Ready**; the server gets a notice.
6. The server records the payment. When the check is paid in full it closes.
7. After the guests leave, the server or host completes the session; the table turns **Dirty**, then **Clean** once it is wiped down.
8. Managers count drawers, finalize tips, write the manager log and review reports.

Takeout skips steps 2, 3 and 7: it is a check with no table.

## Getting started

Your manager creates your account and gives you a temporary password; there is no self sign-up.

**Signing in for the first time**

1. Open the app's web address and enter your email and the temporary password.
2. The app opens **Change password** and nothing else until you choose a new one: at least 14 characters, different from the old one.
3. You land on the **Dashboard**, which shows your location, today's pre-shift notes and, for managers, the day's headline figures.

**Finding your way around**

- **Navigation.** The menu on the left has five groups: **Insights** (dashboard, reports), **Service** (floor, orders, kitchen, bar), **Back of house** (menu, recipes, stock, purchasing), **People** (schedules, time clock, employees) and **Admin**. Only the group you are in opens by default; **Expand all** opens the rest. On a phone, tap **Menu** at the top left.
- **Live updates.** The badge at the top right says **Live** while screens update by themselves, or **Reconnecting…** if the connection drops. Screens also refresh on a timer, so nothing is lost.
- **Confirmations.** Anything that cancels, voids, deactivates or publishes asks first. The safe choice (such as **Keep it**) is selected, so Enter or Escape backs out.
- **"Someone else changed this."** If another person saved the same record first, the message offers **Reload**. Reload, check their change, then try again.
- **Errors** show a **Request ID**. Give it to a manager if a problem keeps happening.
- **The bell** holds your in-app notices: food or drinks ready, a published schedule, a decision on your time off, low stock and similar. Staff never get texts or emails from the app.
- **Times** always show in the restaurant's time zone. The *business date* runs to the location's cutoff (often 4:00 AM), so a 1:00 AM check belongs to the night before.

**Passwords and lockout**

- Change your password any time with **Change password** in the header. Your other devices are signed out.
- After 5 wrong passwords in 15 minutes, sign-in locks for 15 minutes. The message still says "Invalid email or password". Wait, or ask a manager to **Unlock** you.
- Forgot it? There is no reset email. A manager chooses **Reset password** and gives you a new temporary one in person.

**If the connection drops**

The app needs a connection; it does not work offline. If a save fails, read the message and look at the record before trying again. Pressing **Send** twice on an order is safe: the kitchen gets one ticket.

## Hosts: reservations, waitlist and seating

Hosts plan who sits where and start each table session; servers take over once the party is seated. Pages: **Reservations**, **Waitlist**, **Guests**, **Events** and **Floor**, all under **Service**.

**Taking a reservation**

1. Open **Reservations** and choose a date, time and party size. Pick tables if you know them; up to 3 tables in one area can be combined.
2. Use **Find a guest profile** to link a returning guest, or choose **New profile for "…"**. Nothing links by itself, so check it is the right person.
3. Record allergies under **Guest & allergies** (allergen, *Allergy* or *Severe*, a note). Tick **Also save to the profile** to keep it for next time.
4. Tick **Guest agreed to texts** or **Guest agreed to emails** only if the guest said yes. They then get a confirmation, change and cancellation notices and a reminder.

Bookings guests make on the restaurant's own booking page show an **Online** mark and arrive without tables; plan them like any other. If the restaurant approves online bookings first, they arrive as *Pending* until you choose **Confirm**.

**Arrivals, walk-ins and the waitlist**

- When a reservation arrives, check it in. Checking in does not take a table; seating does.
- A walk-in with no table free goes on the **Waitlist** with a quoted wait. When a table is ready, choose **Notify** (sends a text if the guest agreed) or **Mark notified** and tell them in person.
- A reservation becomes **No-show** only when a host marks it, and only after its grace period (15 minutes by default) has passed.

**Seating a party**

1. Open **Floor**. Each table shows whether it is free, occupied, held for a booking or event, and whether it is Clean, Dirty or Out of service.
2. Select one or more clean, free tables, enter the party size and, if you like, the server, then choose **Seat party**. Seating from the reservation or waitlist card does the same.
3. A table held for an upcoming reservation or event can only be used by a manager, with a reason.

To move a seated party or join two parties, use the move action on the session; the same hold rules apply.

**Guest profiles**

**Guests** finds a guest by name (or phone and email, if your role shows contact details). A profile lists visits, no-shows, average spend, allergies, preferences and notes. Never write payment details, health details beyond allergies, or anything you would not want the guest to read. Managers can merge duplicates (never undone); owners and general managers can erase a guest's personal data on request.

**Events and private dining**

Managers book parties and buyouts under **Events**: inquiry, then tentative, confirmed, and completed or cancelled. A tentative or confirmed event holds its tables, area or the whole restaurant from setup to teardown, so reservations, the waitlist and online booking cannot use that space. The reservation book shows an **Events holding space** band. On the day, seat the event from its page as one party; it completes when that session ends. Deposits and minimum spend are noted on the event for information only; the app takes no deposit. Print the **event sheet** for the kitchen and floor team.

## Servers and bartenders: taking orders

An order is built as drafts and only reaches the kitchen and bar when you press **Send**. Drafts can be changed freely; sent items are a permanent record.

**Opening a check**

- **Dining room or bar seat:** open the table from **Floor** or **Orders** and open a check on its session. A table can have several checks.
- **Bar tab with no table, or takeout:** open the check from **Orders** with that order type. Takeout takes a name, never a table.

**Adding items**

1. Pick a category or type in **Search the menu** (press **/** to jump there).
2. Choose the required options (for example temperature, cheese), quantity, course and seat, and type any instruction for the cook.
3. Check the price preview and add the item. It sits on the check as a draft.

What the screen tells you:

- **N left** under a price means the item is running low.
- Items **86'd** at your location are listed above the menu and cannot be added.
- A **Happy hour until 6:00 PM** badge shows a special price. The price is set when you press Send, so send before the time on the badge.
- **Prix-fixe and combo items** ask for one choice per course; each choice goes to its own station, and the check shows one price.

**Sending**

When the round is ready, choose **Send N items**. The app records the price and recipe, takes the ingredients out of stock and creates the tickets, all at once. If the connection hiccups, pressing Send again does not create a second ticket.

- **Courses:** if drafts span courses, **Send & hold courses** sends everything but only the first course reaches the kitchen. Choose **Fire course N** when the table is ready for it.
- **Seats:** the **Seat** buttons decide where new items go: **Table** (shared) or a seat number. You can change an item's seat any time while the check is open; the kitchen sees it as **S2**.

**Allergies**

The **Allergies** box at the top of the check shows the party's allergies; on a bar tab or takeout, **Add allergy** records them on the check. Items that match an allergy, or whose ingredients have not all been reviewed (**Allergens incomplete**), show a red warning. When you send, the app lists them: confirm with the guest, then choose **Guest confirmed, send**, or **Don't send yet** to change the order. The kitchen ticket shows the alert.

**Changing a check after sending**

| To do this | Use | Notes |
| --- | --- | --- |
| Take back a sent item | **Void item** | Give a reason and say whether it was made. Only food not made goes back into stock. |
| Split the bill | **Move items** | Tick items and pick a new or existing check at the same table. |
| One check per seat | **Split by seat** | The lowest seat keeps the Table items; each other seat gets its own check. |
| Share one item (a bottle, a platter) | **Share between checks** | Splits the price in 2 to 10 equal shares; the item is made once. |
| Take money off | Discount or comp | Needs the right permission; stock is not returned. |
| Remove tax | **Make tax exempt** | Managers only, with a reason and certificate reference. |
| Apply a loyalty reward | **Loyalty** box, **Redeem** | Only for a guest profile linked to the party; points come off when the check closes. |

A check being paid cannot be split or changed until its settlement is cancelled. A closed check can never be reopened; corrections after that are refunds.

## Kitchen and bar

Cooks work from **Kitchen**, bartenders from **Bar**, and the expediter from **Expo**, which shows every station at once. All three update by themselves.

**Working a ticket**

1. Filter the queue by status, order type or prep station to see your work.
2. Choose **Start** when you begin an item, **Ready** when it is up, and **Complete** when it has gone out.
3. **Ready** sends the server a notice in the bell (food ready or bar order ready).
4. If an item has to be made again, enter a reason and choose **Remake**. The ingredients already used stay used.

**Reading a ticket**

- Each item shows its options, the cook's instructions, the seat (**S2**) and, for prix-fixe items, the set it belongs to.
- An allergy alert sits at the top of any item the guest confirmed after a warning.
- The timer counts from when the course was fired. The ticket turns amber after 10 minutes and red, marked **Late**, after 20.
- Held courses stay off the station queues until the server fires them; Expo lists them as **Held**.
- **New-ticket sound** plays a chime for each new ticket. It is off until you turn it on, on that device only.

**Before the shift**

- **Prep list** shows, per station, how many portions of each item to expect today or on any of the next six days, from the same weekday in recent weeks, and the ingredients that takes. It changes no stock.
- **86 board**: when you run out of something, choose the item (or an option such as "Swiss"), give a reason and choose **86 item**. It comes off sale at once on every order screen at this location, until someone chooses **Restore**. An 86 can also start later or end at close.

## Paying, closing and turning the table

A check closes the moment its payments add up exactly to the amount due (subtotal after discounts, plus tax). Run cards on the card terminal first, then record them here.

**Recording payment**

1. From the check, choose **Settlement**, then **Open Settlement** if none is open.
2. Record each payment. **Cash – exact** and **Card – exact** fill in what is left. For cash, enter the amount, any tip and the cash handed over, and pick the **Cash drawer**. Split payments are just several tenders.
3. Tips can be recorded on cash and card only. **Other** needs a description.
4. Send or remove any drafts on the check, then choose **Complete Settlement and close Order** when the balance reads zero.

A fully comped check closes with a zero payment.

**Gift cards** (when the restaurant has them turned on)

- **Pay with one:** choose **Gift card**, type or scan the code, **Check balance**, then **Use balance** or a smaller amount. Put the rest on another tender.
- **Sell or reload one:** open **Gift cards**, choose **New card** or **Reload a card**, enter the amount and how the guest paid. A new card's code appears **once**: write it on the card straight away. Selling a card is not a sale on a check and carries no tax or tip.
- Record another company's gift card as **Other**.

**Refunds** (managers)

On a closed check's settlement screen, under **Refunds**, record what was given back: tender, amount with its tax part, any tip refunded, and a reason. Give the money back outside the app first. The check stays closed. A mistaken refund can be voided with a reason.

**Cash drawers** (managers)

Under **Cash drawers**, open a drawer with its **Starting float** and record any **Paid in** or **Paid out** with a reason. At close, enter **Cash counted** and choose **Close drawer**; the app shows expected cash and the over or short. A drawer can't close while one of its checks is still being paid.

**Turning the table**

Closing the check does not free the table. After the guests leave:

1. On **Floor**, choose **Complete session**. The table turns **Dirty**, and a linked guest earns loyalty points now.
2. Once it is cleaned and reset, mark it **Clean**. It is now free to seat.

Use **Out of service** for a wobbly or broken table so nobody seats it.

## Every employee: schedule, time clock and shift duties

Every employee uses the **People** pages for their own schedule and hours, and **Pre-shift** and **Checklists** during the shift.

**Your schedule**

- **My schedule** shows your published shifts. You get a bell notice when a schedule with your shifts is published or a shift changes.
- Set your **availability** there. The schedule only gives you shifts your availability fully covers, so keep it up to date.
- **Request time off** there. Approved time off is never scheduled over; you get a notice when it is approved or denied.
- **Swap a shift:** ask to swap a published shift with a co-worker who can work that position. It changes only once the swap is accepted and approved.
- **Timeline** shows the whole day's shifts as a chart, by employee or by position.

**Clocking in and out**

1. Open **My time** and choose **Clock in**. If you work more than one position here, pick today's.
2. **Start unpaid break** and **End break** around an unpaid break.
3. **Clock out** when you leave.

The page shows this week's hours against overtime (**On track**, **Near overtime**, **In overtime**) and your finalized tip shares. Under **Cash tips I kept**, declare cash tips you kept; it is a record only. Forgot to clock out? Tell a manager: the shift counts zero hours until they close it.

**Pre-shift notes**

**Pre-shift** (and the Dashboard) shows today's notes for everyone and for your positions: specials, 86s, VIPs, reminders. Pinned notes come first. Managers write them up to 14 days ahead.

**Checklists**

**Checklists** lists today's opening, closing and side-work lists for your positions.

1. Start the checklist. It is copied for today's business date.
2. Tick each item when done, or skip it with a reason. The list can't be completed while a required item is still open.
3. Choose **Complete**. Some lists then need a different manager to **Sign off**. A completed list can't be changed.

**Temperature log**

Where your role allows, record readings under **Temperature log**: pick the point (walk-in, line cooler, hot holding), enter the reading and save. A reading outside the safe range needs a corrective action written with it, and managers get an alert at once. Readings can't be edited; record a recheck as a new reading. Points that are due or overdue are marked.

## Managers: menu, stock and running the shift

Managers set up what is sold and what it is made from, keep stock right, and record what happened each day. Changes to prices or recipes never alter checks already sent.

**Menu and pricing** (Back of house)

- **Manage menu**: add items and categories, set prices and the tax category, and mark items *available* or not. Items are deactivated, never deleted.
- **Modifiers**: option groups such as temperature or cheese, with any price or ingredient change.
- **Prix-fixe and combos**: build a bundle with courses, the items offered in each and any upcharge. It is sold as one price; each choice goes to its own station.
- **Happy hour**: add a price period with days, local start and end times, optional order types and dates, and a price per item. An end before the start runs past midnight. **Deactivate** ends it.
- **86 board** settings: turn on auto-86 so items come off sale when recorded stock can't make one more; **Sell anyway** overrides it for the rest of the day.

**Recipes, allergens and nutrition**

- **Recipes** list each item's ingredients and quantities. A change makes a new version from a date; past sales keep the version they used.
- **Allergens**: tick what each ingredient contains and choose **Save and mark reviewed**, even when it contains none. Until every ingredient of an item is reviewed, servers see **Allergens incomplete**.
- **Nutrition**: enter figures per ingredient; menu labels add up from the recipe and show **Incomplete** while data is missing.

**Inventory**

Stock only moves through the app's records, so on-hand figures always match their history.

1. **Inventory counts**: start a count, enter what is on the shelf, and complete it. Differences become adjustments.
2. Record waste, spoilage and corrections as adjustments with a reason; nothing is ever erased.
3. **Transfers** send stock to another location; it is *in transit* until they receive it.
4. **Lots**: for items with use-by dates, turn on lot tracking. Each delivery records the lot code and date, and stock is used first to expire, first out. The bell warns before a lot expires; **Trace** shows where a lot went.

**Purchasing**

1. **Suggested orders** lists what to buy per supplier, from par levels or from the sales forecast, and **Create draft orders** makes draft purchase orders. Nothing is sent to a supplier by the app.
2. Submit the **Purchase order** yourself. Stock goes up only when you **receive** it; part deliveries are fine.
3. When the bill arrives, enter it under **Supplier invoices**, matching each line to what was received, and attach a scan if you like. Lines outside the price tolerance need a reason at approval. Invoices are a record and never change stock or cost.
4. You get a bell notice when an item falls below its reorder level.

**Daily records**

- **Manager log**: write what happened today (incidents, repairs, complaints, staffing). Entries can't be edited; choose **Correct** to add a correction. Owners and general managers can **Redact** one with a reason. Never write guests' contact or health details here.
- **Pre-shift**, **Manage notes**: write notes for today or up to 14 days ahead, for everyone or chosen positions, optionally pinned.
- **Checklists**, **Manage**: build opening, closing and side-work templates; **History** shows completed and missed lists.
- **Temperature log**, **Points**: set up each fridge or holding point with its safe range and how often to check it.

**Labor and tips**

- **Scheduling**: create a schedule period, add shifts from a template (optionally sized by the demand forecast), let the app fill them, fix any warnings and **Publish**. The app never publishes on its own; after publishing, shifts change only through swaps.
- **Time clock**: see who is on, clock someone in or out, fix a missed clock-out or wrong time with a reason, edit breaks or void a mistaken entry.
- **Scheduling requests**: approve or deny time off and swaps.
- **Tips**: set points per position, review the day's pool (hours × points) and **Finalize tips** once every check is closed and everyone has clocked out. Pay tips outside the app.

## Reports, exports and audit

Reports only read data; nothing you do on a report page changes anything. Open **Reports**, pick an area and a date range, and download any table as CSV. Dates are business dates. With access to two or more locations, **All my locations** shows one row per location plus a total.

| Report area | What it answers | Highlights |
| --- | --- | --- |
| Sales | What did we sell? | Net sales by date and order type, sales by hour, happy hour results, tax-exempt checks, sales forecast, loyalty points |
| Menu | Which items earn their place? | Item mix, menu engineering, modifiers sold, food cost per sale, bundle components |
| Settlements | How were we paid? | Tenders and tips, refunds, gift card value sold, spent and owed, unused gift card balances |
| Orders | How did checks and servers go? | Check speed, voids, comps and discounts by employee, server performance |
| Fulfillment | How fast was the kitchen and bar? | Ticket times by station, late items, remakes |
| Seating | How did the floor turn? | Covers, table turns, reservations, no-shows, waitlist |
| Labor | Who worked and what did it cost? | Scheduled vs actual hours, overtime, time clock exceptions, forecast vs actual (cost needs compensation access) |
| Tips | What did staff earn in tips? | Tips by date and server, finalized pool shares, refunded and declared cash tips |
| Inventory | Where did stock go? | Usage, waste, count variance, 86 history, in transit, invoice variances, received but not invoiced |

**Exports** (Insights) gives two files for outside software: the **Sales and tax journal** (balanced debits and credits per day, for your bookkeeper) and **Payroll hours** (regular and overtime per employee and week, never pay rates). Payroll hours refuses while a time entry in those weeks is still open. Owners and general managers can also download the **Gift card holder report** for unclaimed-property filings.

**Audit** (Insights) lists sensitive and money-related actions: who did what, when, and the fields before and after. Choose **Show** on an entry for details. Audit entries can't be changed or deleted.

## Administration (owners and general managers)

Administrators set up people, access and locations. Most of these pages sit under **Admin** and **People**.

**Adding a new employee**

1. Under **Employees**, create the employee record and give them their positions (the jobs they work) and the pay for each position. Pay is kept per employee and position, and a change starts from a date; old rates are never overwritten.
2. Under **Admin → Users**, create their sign-in, link it to the employee record and give them a security role at this location. Hand over the temporary password in person.
3. Ask them to set their availability so the schedule can use them.

Someone already working at another location: **Add an existing person** finds them by email and gives them a role here.

**When someone leaves**

Terminate the employee on their record. This ends their scheduling and disables their sign-in at once. Someone still on the clock must be clocked out first.

**Access**

- **Roles** bundles permissions; the defaults are Owner, General Manager, Manager, Server, Bartender, Host, Cook, Wait Staff and Inventory Manager. **Permissions** lists what each permission allows.
- HR details are tiered: general details, management details, and restricted details (pay, discipline, address, emergency contacts), each behind its own permission.
- **Unlock** a locked account or **Reset password** from the user's card. A reset password is shown once.

**Locations and floor**

- **Locations**: **Open a new location** with a name, code and time zone, optionally copying setup (menus, prices, taxes, stations, rules, checklists) from another. Staff, tables, stock and history are never copied. A location can be closed only when nothing is open there.
- **Areas**, **Tables** and **Sections** set up the floor; **Prep stations** decide which station gets which items.
- **Taxes**: add tax categories, set each rate at this location (with a start date), and tick **Menu prices already include this tax** where the menu price is tax-included.

**Programs and settings**

- **Gift cards** → Settings: turn the program on, set the most a card can hold and the dormancy period, register supplier card stock.
- **Loyalty**: turn points on, set points per dollar and per visit, and add rewards.
- **Online booking** (host stand tab): turn the public booking page on, set hours, party limit, pacing and lead time, and share the page's address.
- **Staffing & rules**: overtime thresholds, staffing templates and ratios for the demand forecast.
- **System health**: waiting and failed live updates and guest messages, with **Retry**.

## Quick reference

These are the default roles; your restaurant may have changed what each one allows.

| Role | Main pages | Typical tasks |
| --- | --- | --- |
| Host | Reservations, Waitlist, Guests, Floor | Book, check in, waitlist, seat parties, mark tables clean |
| Server | Orders, Floor, Settlement | Open checks, send items, split checks, record payment, complete sessions |
| Bartender | Bar, Orders, Settlement | Bar tabs, work bar tickets, record payment |
| Cook | Kitchen, Expo, Prep list, 86 board | Work tickets, 86 items, check the prep list |
| Wait Staff | Floor, Expo | Run food, clear and reset tables |
| Inventory Manager | Inventory, Purchasing | Counts, receiving, adjustments, transfers |
| Manager | Most of Service, Back of house and People | Voids, comps, refunds, drawers, schedules, time clock, tips, menu, manager log |
| General Manager | Everything above plus Admin | Users, roles, locations, taxes, redaction, guest erase |
| Owner | Everything | All of the above |

Every employee also has **My schedule**, **My time**, **Pre-shift** and the **Dashboard**.

**Common messages and what to do**

| You see | What it means | What to do |
| --- | --- | --- |
| A page or button is missing | Your role doesn't include it | Ask a manager to check your role |
| "Someone else changed this" with **Reload** | Another person saved first | Reload, check, try again |
| Location changed | You switched location in another tab | Reload the page |
| Allergy warning at Send | An item may conflict with a guest's allergy | Check with the guest, then confirm or change the order |
| Item can't be added or sent | It is 86'd, or has no tax category | Pick another item; tell a manager |
| Table is held | A reservation or event is due there | Seat elsewhere, or a manager overrides with a reason |
| Can't complete settlement | Drafts on the check or money still owed | Send or remove drafts; record the rest |
| Drawer won't close | A check paid into it is still being settled | Finish that settlement first |
| Payroll hours export refused | Someone has an open time entry | Fix the missed clock-out, then export |
| "Invalid email or password" after several tries | Account locked for 15 minutes | Wait, or ask a manager to unlock |

**What the app does not do**

It does not charge cards, pay wages or tips, or send texts or emails to staff. It does not work offline, reopen closed checks or send marketing to guests. Online bookings take no deposits.
