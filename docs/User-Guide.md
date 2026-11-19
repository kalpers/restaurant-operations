# Restaurant Operations App: User Guide

This guide walks restaurant staff and managers through the workflows currently available in the application. Your available pages and actions depend on your account permissions and assigned location.

## Before You Begin

Sign in at the application URL provided by your administrator using your restaurant account. The navigation is permission-filtered: if a page or action described here is missing, ask an administrator to check your account's location access and permissions.

The **Dashboard** shows your location and roles. With report access it also shows one business date's headline figures, each compared with the previous business date. The Phase 13 validation seed creates test records, but it does **not** create a demo login account.

### Finding your way around

- **Navigation.** The menu on the left is grouped into **Insights**, **Service**, **Back of house**, **People** and **Admin**. You only see the links your permissions allow, and the page you are on is highlighted. On a phone or narrow tablet, tap **Menu** at the top left to open it; it closes when you choose a page or press Escape.
- **Live updates.** The badge at the top right says **Live** while the screen receives updates, or **Reconnecting…** if the connection dropped. Screens also refresh on a timer, so nothing is lost while reconnecting.
- **Confirmations.** Anything that cancels, removes, deactivates, disables, archives, voids or publishes asks first. The safe choice (for example **Keep it**) is selected, so pressing Enter or Escape backs out.
- **Messages.** A short message at the bottom of the screen confirms a save (**Saved.**). Errors stay next to the form or button that failed. If someone else changed the same record first, the message offers **Reload**. Errors also show a **Request ID**, which an administrator can use to find the problem in the logs.
- **Statuses** are shown as colored labels with words, such as **Preparing** or **Out of service**. The word always carries the meaning; the color only helps you scan.

## A Service-Day Walkthrough

This is the usual path from a guest's arrival through closing their table. Takeout orders skip the seating steps.

### 1. Check reservations and the waitlist

1. Open **Reservations & Waitlist**.
2. Find the arriving reservation or waitlist party, and use the available host actions to record their arrival or manage their wait.
3. When seating a party, continue through the reservation/waitlist seating action or use **Restaurant floor** to choose tables.

Reservation holds appear on the floor. An override may require a reason and the appropriate permission.

**Guest profiles and allergies.** When booking or adding a walk-in, use **Find a guest profile**: type a name (or phone or email, if you can see contact details) and pick the guest, or choose **New profile for "…"**. Nothing links by itself, so check it's the right person. On a reservation or waitlist card, **Guest & allergies** shows the linked profile and the allergies for this visit: link or change the profile, and **Record allergy** (allergen, *Allergy* or *Severe*, an optional note). Tick **Also save to the profile** to keep it for next time. A profile's allergies are copied onto each visit linked to it. Cards show a **VIP** mark and an **Allergy** mark with the allergen names.

**Texts and emails to guests.** The reservation and waitlist forms have two boxes, **Guest agreed to texts** and **Guest agreed to emails**. Tick one only when the guest said yes; they start unticked. With consent, the guest gets their confirmation, any change of date, time or party size, a cancellation notice and a reminder before the booking (only between 9 am and 9 pm), and, on the waitlist, a "your table is ready" message when you press **Notify (sends table-ready message)**. Without consent the button says **Mark notified** and the card reminds you to tell the guest in person. Texts need a mobile number we can use: 10 digits, or a number starting with + and the country code. Changing the phone or email stops messages to the old one until the guest agrees again.

Each card has **Messages**: which channels the guest agreed to (with **Stop texts** or **Stop emails**), and every message with its status (*Waiting to send*, *Sent*, *Failed*, *Opted out* or *Not sent*). A failed message has **Retry**; a confirmed booking has **Send confirmation again**; a notified waitlist party has **Text again** (at most once a minute). You see the full phone or email only if you can see guest contact details. Messages never include notes, special requests or allergies. A guest who replies STOP, or uses the link in an email, gets no more messages at that address.

**Online bookings.** Bookings guests make themselves show an **Online** mark. They have no table planned yet: plan tables as usual. If the restaurant holds online bookings for approval, they arrive as *Pending*; **Confirm** sends the guest their confirmation. Allergies the guest gave appear like any other. An online booking is never linked to a guest profile by itself; use **Guest & allergies** to link one. To remove the personal details of a booking with no profile (a guest's request), an owner or general manager chooses **Erase guest details** and gives a reason.

### 2. Seat the party

1. Open **Restaurant floor** and check the table's status. Only clean, available tables can normally be selected.
2. Select one or more tables. Multiple tables can be combined for one party.
3. Enter the guest name and party size, optionally assign a server, then choose **Seat party**.

The active table session represents the seated party. Orders are associated with this session, not directly with an individual table. If a table is unavailable because of capacity, staffing, or a reservation hold, only authorized users can override the restriction and may need to give a reason.

### 3. Open a check and add items

1. Open **Orders**.
2. For dine-in or bar service, open **Open Order**, select the service type and active table session, then open the order. For takeout, choose **Open Takeout**; it does not need a table session.
3. Select a menu category and item, or type in **Search the menu** (press **/** to jump there). Choose the required modifiers, enter quantity, and add any kitchen instructions.
4. Review the price preview and choose **Add Draft Item**. Repeat for more items.
5. Review the draft list. Use **Edit** to change a draft item or **Remove** to remove it before sending.

Draft items are not sent to the kitchen or bar and do not consume inventory. When the guest's current round is ready, choose **Submit _N_ Items**. Submission records the item and price snapshots, posts applicable inventory consumption, and creates fulfillment tickets. Add later rounds as new drafts and submit them separately.

Items running low show **N left** under their price. Items 86'd at your location are listed above the menu and can't be added or sent; if an item is 86'd after you add it, **Submit** refuses it and you remove the draft.

The check on the right stays in view while you scroll the menu. It shows how many items are not sent yet and the running total of what has been sent.

**Courses.** When adding an item, choose its **Course** (1 to 5). If the drafts span more than one course, **Send & hold courses …** sends everything now but only the first course goes to the kitchen. The later courses wait under **Held courses** until you choose **Fire course _N_**. Held food is already counted against inventory, because it was ordered.

**Ringing by seat.** On a check at a table, the **Seat** buttons above the menu choose where new items go: **Table** (shared, or not for anyone in particular) or a seat number. Seats 1 to the party size are offered; **+ seat** adds one more. Each line on the check has a seat picker, so you can fix a seat at any time while the check is open, even after the food has gone out; the kitchen and Expo show the seat (**S2**) and update when you change it. **By seat** lists the check seat by seat with a subtotal for each (before check discounts and tax). Takeout checks have no seats.

**Splitting by seat.** Choose **Split by seat** to give every seat its own check at the table in one step. The lowest seat stays on this check with the **Table** items; every other seat goes to a new check. Nothing is shared automatically: use **Share between checks** afterwards on any Table item the guests want to divide. Discounts on the whole check stay on this check, and an item that is already shared stays where it is.

**Splitting the bill.** Choose **Move items**, tick the items (sent or not), and pick **A new check at this table** or another open check at the same table. Prices, discounts on those items and their kitchen progress go with them; discounts on the whole check stay on it. A check that is being settled can't be split until its settlement is cancelled.

**Sharing one item.** To split one sent item (a bottle of wine, a shared platter) between guests, choose **Share between checks** on it, pick the number of shares (2 to 10) and the check each share goes on. The price is split into equal shares, to the cent, with its tax. The item is still made once: its kitchen work and stock stay with it. A discounted item can't be shared; remove the discount first. To take a share off a check, choose **Void share** under **Shared items**; it removes the money only.

**Tax-exempt checks.** A manager can choose **Make tax exempt** under the totals, give a reason and, if the guest has one, an exemption certificate reference (never a card number). The check then pays no tax; items whose price includes tax are reduced by that tax. **Remove tax exemption** undoes it while the check is open. Neither can change while the check is being settled.

**Allergies on the check.** The **Allergies** box at the top of the check shows the party's allergies (from the host stand or the guest's profile), or, on a takeout or bar check with no party, the check's own; choose **Add allergy** to record one. Each item shows its allergens (and **May contain …** for cross-contact). An item that matches an allergy, or whose allergens haven't been fully reviewed (**Allergens incomplete**), shows a red warning. When you send, a window lists those items: check with the guest, then choose **Guest confirmed, send**, or **Don't send yet** to change the order. Confirmed items show **Sent after allergy check**, and the kitchen ticket shows the allergy alert at the top of the item.

Submitted items are historical records. To void one, choose **Void item** on it: a window asks for a reason and whether it was prepared, and for a final confirmation. Choose **Not prepared** only when it was not prepared; prepared or discarded food remains consumed.

### 4. Prepare and fulfill submitted items

1. Kitchen staff open **Kitchen Queue**; bar staff open **Bar Queue**. **Expo** provides a combined, read-only view.
2. Use the status, order type, and prep-station filters to focus the queue.
3. For each item, select **Start**, then **Ready**, then **Complete** as work progresses. The queue refreshes automatically.
4. If an item needs to be remade, enter a reason and choose **Remake**. A remake creates fulfillment work; it does not automatically restore consumed inventory.

Modifier preparation notes and special instructions are shown with the ticket. The status for an individual station may differ from the overall item status while other stations are still working.

Held courses stay off the kitchen and bar queues until they are fired; Expo lists them as **Held**. A fired ticket shows its course.

**Prep list.** Open **Prep list** (under Service) before a shift. For each station it shows how many portions of each item to expect on the date you choose (today or the next six days), worked out from the same weekday in recent weeks: whole portions, rounded up, and for today less what has already been sent. It also shows what guests usually ask for ("about 3 Extra Pickles") and the ingredients those portions take. A new item is marked, because its early weeks pull the number down; an item with no recipe shows portions only. If the weekday doesn't have enough history yet, there are no numbers. Nothing on the prep list changes stock.

Each ticket shows how long it has waited (counted from when its course was fired). Its border and header turn amber after 10 minutes and red, marked **Late**, after 20. **New-ticket sound** plays a short chime when a new ticket arrives; it is off until you turn it on, and the choice is remembered on that device only.

### 5. Record settlement and close the check

1. From the selected order, choose **Settlement**.
2. Choose **Open Settlement** if one is not already open.
3. Record each tender using the permitted tender type. For cash, enter the amount applied, tip, and cash received, and choose the **Cash drawer** it went into. Split payments can be recorded as multiple tenders.
4. Confirm the remaining balance, shown in large type, and tips. **Cash – exact** and **Card – exact** fill in the remaining amount for you. Submit or remove any draft items before completing.
5. When the balance is fully settled, choose **Complete Settlement and close Order**.

Settlement is record-keeping only. The app does not charge or authorize cards; any card transaction must be processed in an external system first. You may record safe external references when permitted, but never enter a full card number, security code, PIN, or bank details. The amount due is the subtotal plus tax, where the location charges tax.

**Refunds.** A manager can record money given back to a guest on a closed check, under **Refunds** on its settlement screen: what it was refunded as, the amount (with the tax part), any **Tip refunded** (cash or card only, up to the tips on the check), and a reason. A tip can't be refunded once that day's tips are finalized; void the distribution first. Give the money back outside the app first. The check stays closed; the refund counts on the day it is given. A mistaken refund can be voided with a reason.

### Cash drawers

Open **Cash drawers**. A manager opens a drawer with its **Starting float** at the start of a shift and records any **Paid in** or **Paid out** with a reason. At the end, enter **Cash counted** and choose **Close drawer**: the app shows the expected cash (float, plus cash taken with tips, paid in and cash taken for gift cards, less paid out, cash refunds and gift card cash-outs) and the variance (counted minus expected). A drawer can't close while a check with cash in it is still being settled. Where the location requires a drawer, cash can't be recorded until one is open.

### 6. Complete the table session and clean the table

Closing the order does not free the table. After the guests leave, return to **Restaurant floor**, choose **Complete session**, then mark the table clean after it has been cleaned. The table becomes available only when the session is complete and the physical table is clean.

## Other Workspaces

### Scheduling

Open **Scheduling** to review schedule periods. Users with schedule-edit access can create a period and manage its shifts and assignments. Where enabled, automatic generation creates a **draft** schedule: review coverage, warnings, and assignments, make corrections, then publish it explicitly. Generation never publishes automatically.

#### Viewing the day's schedule

Open **Timeline** to see one day's shifts as a chart, with time across the top. Each bar is one person's shift, labeled with the position and the start and end times. Use **Previous day**, **Today**, **Next day** or the date box to change the day, and **By employee** or **By position** to change how rows are grouped. A dashed, striped bar marked **Open** is a place nobody is assigned to yet. The rows of numbers above the chart show how many people of each position are on in each hour.

Select a bar (click, tap, or press Enter on it) to see its details: position, area, times, how long it is, which schedule it's in, and how many of the people needed are assigned. Press Escape or **Close** to close the details. On a phone the chart scrolls sideways inside its frame, and the details open from the bottom of the screen.

Everyone with access to schedules sees published schedules here. Managers who edit, generate or publish schedules also see drafts (dashed outline, marked **Draft**, with an **Include drafts** switch), grey **Time off** bands, and extra details: how the assignment was made, the "Why this assignment" explanation, shift notes, open swap requests, problems that need fixing, and the person's scheduled hours. They also get a link to the schedule, where changes are made. The timeline itself never changes anything. The day is the date a shift starts, so a shift that runs past midnight shows in full on the day it began.

**My schedule** is the employee self-service area for availability and scheduling requests. **Scheduling requests** is for authorized reviewers to process requests. **Staffing & rules** is for users who manage staffing templates and scheduling rules, including the weekly overtime threshold, the overtime cost multiplier and the late clock-in grace.

#### Sizing shifts from the demand forecast

The forecast estimates how busy each hour of a schedule's dates will be: dining covers, bar checks, takeout checks and all checks. It uses the same weekday over the last few weeks of closed checks (the newest weeks count most) and never goes below the covers already booked for that hour. It needs at least three past weeks of that weekday, so a new location keeps its template counts at first.

1. On **Staffing & rules**, under **Demand forecast**, add a **staffing ratio** for each position you want sized: which demand drives it, how much one person handles in an hour (for example 16 covers per server), and the fewest and most people. Positions without a ratio keep the template's count.
2. If a past day wasn't typical (a storm, a private event), add it under **Dates left out of the history** with a reason. **Put back** includes it again.
3. In the scheduling rules you can change how many weeks are averaged and how many are needed.
4. On a draft schedule, choose a template under **Apply a staffing template** and tick **Size new shifts from the demand forecast**. Each new shift gets the suggested count.
5. The **Demand forecast** panel on the schedule shows each date's busy hours and, for every shift from a template, the template's count, the current count, the suggestion and why ("Busiest hour 19:00–19:59: 48 covers ÷ 16 per server = 3"). **Use suggestion** changes one shift, **Use all suggestions** changes them all; a shift never drops below the people already assigned, and shifts you added by hand are never changed.

Nothing changes until you apply a template with the box ticked or use a suggestion. Generation then fills the shifts as usual, and you still publish yourself.

### Clocking in and out

Open **My time** and choose **Clock in** at the start of your shift. If you hold more than one position here, choose the one you're working. **Start unpaid break** and **End break** record a break; unpaid break time isn't counted as worked. Choose **Clock out** when you leave; an open break ends at the same moment. The page shows this week's entries, your hours so far against the overtime threshold (**On track**, **Near overtime** or **In overtime**), and your finalized tip shares for the last 30 days. Your login must be linked to your employee record; if it isn't, a manager can clock you in instead. Under **Cash tips I kept**, declare cash tips you kept on a day you worked; it's a record only and isn't part of the tip pool.

### Time clock (managers)

Open **Time clock** to see who is on the clock now, with each person's hours this week and overtime state. Managers can:

- **Clock someone in** who has no login, or **Clock out** anyone on the clock. Both are recorded in the audit trail.
- Fix a **missed clock-out**. An entry still open from an earlier day counts no hours until it's closed. Open **Adjust, edit breaks or void**, enter the clock-out time and a reason, and save. Managers also get a **Missed clock-out** alert for it.
- Correct any entry's times or position under **Adjust, edit breaks or void**. Blank fields stay as they are, and a reason is always required. The original punch times are kept with the correction.
- **Edit breaks** there too: change a break's start, end or paid flag, **Add a break**, or tick **Remove**, then give a reason and **Save breaks**. Times are in the restaurant's time zone.
- **Void** an entry made by mistake. It stays on record but counts nowhere.

Choose a date to see that day's entries; adjusted entries are marked **Adjusted**. Someone who is on the clock can't be terminated until they're clocked out.

### Tips

Open **Tips** (managers). Under **Tip pool**, switch pooling on and give points to each position that shares tips, for example Server 10 and Busser 5. Leave a position blank to leave it out. For a business date, the page shows the cash and card tips from closed checks and how they would be shared: hours worked × points. Choose **Finalize tips** once every check is closed and everyone is clocked out. The shares are then saved as they are, and that day's hours can't change. To redo a day, **Void distribution** with a reason, fix what's wrong, then finalize again. Tips are recorded here only; pay them out outside the app. Tips refunded on a check come out of that day's pool. **Declared cash tips** lists what people say they kept in cash; a manager can record one for anyone who worked that day. Declarations are never part of the pool.

### Employees

Open **Employees** to view or manage employee records according to your permissions. Sensitive HR details such as compensation, disciplinary information, personal addresses, and emergency contacts are restricted separately from ordinary employee information. Employee job positions describe restaurant work; they do not grant application access.

### Menu and recipes

Open **Menu** to review currently available, priced menu items and their modifiers. Users with configuration access can choose **Configure menu** or open **Menu & Recipes** to manage menu and recipe data. Orders already submitted retain their recorded item, price, modifier, and recipe-related snapshots when configuration later changes.

**Happy hour.** Under **Back of house → Happy hour**, managers who can change prices add a price period: a name, the days it starts on, the local start and end time (an end before the start runs past midnight, so "Fri 22:00 to 01:00" covers early Saturday), optionally which order types (for example bar only) and first and last dates, and a fixed price for each item. On the order screen, items in a period show a badge such as "Happy hour until 6:00 PM", with the regular price in the item dialog. **The price is set when the item is sent**: an item sent after the period ends sells at the regular price, so send drinks before the badge's time, or record a discount if you want to honour the happy hour price. Two periods can't price the same item for the same order type at the same time. **Deactivate** ends a period; sent items keep the price they sold at, and the Sales report shows what each period sold.

**Nutrition.** On an inventory item, under **Nutrition**, enter its figures for an amount of its base unit (for example per 100 grams, or per 1 each) and choose **Save nutrition**; leave a figure blank if you don't know it. A menu item's **Nutrition** section adds up one portion from its recipe, and lists the ingredients without data. While any ingredient lacks a figure, that figure shows as "At least …" and the label as **Incomplete**; it is never shown as zero. For bought-in items with no recipe, enter **Declared nutrition** on the menu item instead; **Use the recipe instead** removes it. On the order screen, the item dialog shows the calories for the choices made (open **Nutrition** for the rest), once the required choices are picked.

### Guests

Open **Guests** (under **Service**, or the tab at the host stand) to find a guest by name, or by phone or email if you can see contact details. A profile shows visits (date, location, party, what was ordered and the check total), no-shows, average spend, allergies, preferences and notes. Hosts and managers edit profiles; servers can look guests up but don't see phone or email. Never record payment details on a profile.

- **Merge:** a manager opens the duplicate, finds the profile to keep, gives a reason and confirms. Visits and allergies move over (the more severe allergy wins), and the duplicate closes. A merge can't be undone.
- **Erase:** when a guest asks to be forgotten, an owner or general manager chooses **Erase personal data**. The name becomes "Erased guest" and contact details, notes, preferences and allergies are removed from the profile, any profile merged into it and its past visits. Orders and reports are kept. Don't put the guest's name in the reason.

### Loyalty points

When the program is on, a guest earns points on each visit that is linked to their profile. **Link the profile at the host stand before the guests leave**: points are worked out when the table session ends, from the closed checks' subtotals (after discounts, before tax and tips), and a visit can't be linked afterwards. Takeout and tabs with no guest party don't earn.

- **Set up:** a manager opens **Loyalty** (under **Service**), ticks **Guests earn and redeem points**, sets the points per $1 and per visit, and adds rewards. A reward costs points and takes an amount or percentage off one item or the whole check (100% makes the item free). Changing the rates affects visits that finish afterwards only.
- **Redeem:** on the order screen, the **Loyalty** box shows the linked guest's available points. Choose a reward they can afford (and the item, for an item reward) and **Redeem**. It appears on the check as a discount named "Loyalty: …". The points stay on the guest's balance, shown as not available, until the check closes; if a manager removes the discount first, nothing is taken.
- **Profile:** the guest's profile shows the balance, what's available, rewards on open checks and every change with its business date. A manager can **Adjust points** with a reason (for example a goodwill gift or a mistake).
- **Merge and erase:** merging moves the duplicate's points to the profile kept; erasing clears the balance. Both wait until no reward is on an open check. A visit that used a reward keeps its guest (it can't be unlinked).
- **Refunds** don't change points. The refund screen shows what the visit earned, with a link to adjust if needed.
- Reports: **Sales** shows points earned, redeemed and adjusted per day, rewards used and their discount, and the points guests hold now.

### Gift cards

The restaurant's own gift cards work at every location. A manager turns them on under **Gift cards** (in **Service**), in **Settings**, and sets the most a card can hold. Once they are on, every **Gift card** tender must be one of these cards; record another company's gift card as **Other**. Selling a card isn't a sale: it carries no tax or tip and doesn't count in sales.

- **Sell:** on **Gift cards**, choose **New card**, enter the amount and how the guest paid (cash into a drawer, a card on the external terminal, or other), and **Sell card**. The card's code appears once, in large type. **Write it on the card now**: the app keeps only a scrambled copy and can never show it again. The receipt number (for example GC-000012) is not the code.
- **Reload:** choose **Reload a card**, type or scan its code, and add the amount.
- **Pay with a card:** on the settlement screen choose **Gift card** as the tender, type or scan the code, **Check balance**, then **Use balance** (or type a smaller amount) and record it. The rest of the check goes on another tender. If the tender is voided, the value goes back on the card.
- **Check a balance:** type the code under **Look up a card**. Managers can also find a card by its receipt number.
- **Refund onto a card:** on a closed check paid with a gift card, choose **Gift card** under **Refunded as** and pick the card. Only a card that paid the check can take a refund, up to what it paid.
- **Managers:** on a card's page, **Adjust** adds or takes off value with a reason; **Cash out** pays the whole balance in cash from an open drawer; **Deactivate** stops a lost or stolen card being used (its balance stays); **Replace code** gives the card a new code for a guest who lost it (the new code is shown once). A sale entered by mistake can be voided while none of its value has been spent and, for cash, its drawer is still open.
- **Drawers** count cash taken for gift cards and cash paid out for them; both show on the drawer.
- Reports: **Settlements** shows gift card value sold, spent, refunded, adjusted and cashed out per day, and what is owed on all cards. Gift cards can't be turned off while any card holds a balance.

### Allergens

Managers and inventory managers set allergens up. On each inventory item, under **Allergens**, tick what the ingredient contains and choose **Save and mark reviewed**, even when it contains none. On a menu item, the **Allergens** section shows the label worked out from its recipe; declare **Contains** for what the recipe doesn't show (an item with no recipe) and **May contain** for cross-contact, then save. **Allergens** under **Back of house** lists ingredients in current recipes that nobody has reviewed, and manages the allergen list. Until every ingredient of an item is reviewed, the item shows **Allergens incomplete**, which servers treat as a possible match. Labels are only as good as this data.

### Pre-shift notes

Open **Pre-shift** (in **Service**), or look at **Pre-shift notes today** on the **Dashboard**. You see today's notes meant for everyone and those for your positions at this location. Pinned notes come first.

Managers choose **Manage notes** to write a note for today or up to 14 days ahead. Give it a title and the note itself. Tick the positions it is for, or none for everyone, and **Pin to the top** if it matters most. Until its date has passed, a note can be changed with **Edit** or taken down with **Withdraw**. A withdrawn note stays listed for managers. Choosing positions only decides who sees the note on their page; anyone can be told what it says.

### Manager log

Managers record what happened at the location under **Manager log** (in **Service**). Typical entries are incidents, repairs, staffing changes and guest complaints.

- **Add an entry:** choose a category and write the entry. It goes on today's business date, or choose **The previous business date** when writing up the night after the cutoff.
- **Correct an entry:** entries can't be edited or deleted. Choose **Correct** on an entry and write the correction. The original stays, marked **Corrected by LOG-…**.
- **Find entries:** pick a **Business date**, filter by category, or search the text across up to 31 days.
- **Redact:** if an entry holds something that must not be kept, such as a guest's phone number, a health detail or an HR matter, an Owner or General Manager chooses **Redact** and gives a reason. The text is removed for good. The entry's number, date, category and author stay, with who redacted it and why, and the redaction is in the audit trail.

Don't write guests' contact details, health details or HR matters in the log in the first place.

### The 86 board

Open **86 board** to see what can't be sold at your location right now, what is running low (five portions or fewer, from recorded stock and the current recipe), what is being sold anyway today, and what was restored today. Everyone with menu access can see it.

- **86 an item:** kitchen, bar and managers choose the item, give a reason (for example "Out of salmon") and choose **86 item**. It comes off sale at this location only, at once, on every order screen. It stays 86'd until someone chooses **Restore** on it; it doesn't end at close.
- **Auto-86 from stock:** a manager who manages locations can turn this on for the location. Then an item whose recipe can't be made once more from recorded stock comes off sale by itself, and comes back when stock is received or counted.
- **Sell anyway:** when recorded stock is wrong (a delivery not yet received, a bad count), a manager can sell an auto-86'd item anyway, with a reason. It lasts until the end of the business date. It never lifts a manual 86.
- **Later or for a while:** an 86 can start later (**Starts**, for example 9 PM) and end at a time (**Ends**) or **Until close** (the end of the business day). It appears under **Scheduled** until it starts and under **Ended today** after it ends. **Cancel the 86** removes a scheduled one.
- **86 a modifier:** choose a modifier (for example "Swiss instead") and a reason. It can't be chosen at this location until restored. An item that needs a choice from a group with none left comes off sale too.
- **Running low** means 1 to 5 portions left unless a manager who manages locations sets another number under the auto-86 setting.

### Inventory and purchasing

Open **Inventory & Purchasing** to review stock, low-stock items, and inventory transactions. Depending on your permissions, the workspace also supports counts, adjustments, purchasing, receiving, and inventory configuration.

**Low-stock alerts.** When stock of an item falls to or below its reorder level, people who manage purchasing at the location get an in-app alert (the bell), once per drop; it clears itself when stock is back above the level. **Low stock** shows when each alert opened.

**Suggested orders.** On an item's stock settings, choose a **Preferred supplier**. Then **Suggested orders** lists, per supplier, what to order: enough to reach the reorder target, less what is already on order, in whole cases. **Create draft orders** makes one draft purchase order per supplier. Review, change and submit them as usual; nothing is sent to a supplier by itself. Items with no preferred supplier are listed so you can choose one.

**Ordering from the forecast.** On **Suggested orders**, set **Based on** to **The forecast**, choose the date to order through (up to two weeks ahead), and choose **Show**. Each item then needs what the forecast says the coming days will use (from the recipes and the modifiers guests usually choose), plus its reorder level, less what is on hand and on order. Items the forecast doesn't cover, such as napkins, still follow their par levels and are marked **Par**. Dates without enough history are listed and add nothing. **Create draft orders** makes drafts as usual and keeps a copy of the forecast they came from.

**Transfers between locations.** Open **Inventory → Transfers**. Under **New transfer**, choose the location, add items and quantities, and **Save draft**. When the stock leaves, choose **Send**: it leaves your stock and is *in transit* until the other location receives it. There, **Arriving here** lists it: enter what actually arrived for each item and choose **Receive**. Anything missing is recorded as a transfer shortage at the receiving location. A draft can be cancelled; a sent transfer can't, so send the stock back instead. If you work at both locations, **Send and receive now** does it in one step.

**Lots and use-by dates.** For items with a use-by date (dairy, meat, fish), open the item and choose **Turn lot tracking on**; stock already on hand becomes an opening lot. Each delivery then asks for the supplier's lot code and use-by date, and stock is used first to expire, first out, including when orders are sent to the kitchen. **Inventory → Lots** lists every lot with stock, marked *Expiring soon* or *Expired*. **Waste lot** throws out what is left of one lot; **Correct code or date** fixes a typing mistake (with a reason). Managers get a notice in the bell when a lot is about to expire and again when it has; the number of days' warning is a location setting. **Trace** shows where a lot came from, where it was sent, and which orders used it.

Receiving goods changes on-hand inventory; creating a purchase order by itself does not. Inventory changes are recorded as transactions. Use the inventory workflows rather than attempting to correct stock outside the app, so the stock balance and movement history stay aligned.

### Reporting

Open **Reporting**, choose an available report, and set the date range. If you can see a report at two or more locations, the **Location** list also offers **All my locations**: one row per location and a total, each location on its own business dates. The Dashboard then shows **Today at all my locations**. Inventory reports include **In transit** (sent and not yet received). Which reports and export actions appear depends on your permissions. Reports use the selected location and operational business dates; an early-morning clock time may belong to the previous restaurant business date.

The **Labor** report shows scheduled labor first, then actual labor from the time clock: worked hours, regular and overtime hours, scheduled vs. actual by day (late, early out, unscheduled, no-show), overtime by work week, and time clock exceptions (missed clock-outs, corrections, voids). Labor cost appears only for people allowed to see compensation. The **Tips** report shows tips by date and tender, direct tips by server, and finalized tip shares. The Labor report ends with **Forecast vs actual**: for past dates that had a demand forecast, what was forecast and what happened, per day. The Inventory report ends with **Item forecast vs actual**: for past dates covered by a forecast that draft orders were made from, the forecast and sold portions of each item.

Also in the reports: **Sales by hour** (by the hour each check was opened, from the start of the business day, with a bar chart above the table), **Item mix** and **Menu engineering** (Star, Plowhorse, Puzzle, Dog, shown to people who can see cost), **Server performance** (tips appear only for people who can see tips), **Voids, comps and discounts by employee** (facts only, no thresholds), and **86 history** in Inventory. **Item mix by category** and **Menu engineering by category** compare items only within the category they were sold under; items sold before categories were recorded show as Uncategorized. Sales also lists **Tax-exempt checks**, and Tips shows refunded tips and declared cash tips.

The Sales report also shows **Price periods** (what each happy hour sold, its regular value and the difference), **Sales forecast** for the next 14 days (expected net sales per day and hour, from the same weekday's closed checks in recent weeks) and **Sales forecast vs actual** for past dates whose forecast was used for the schedule. Only people who can see sales reports see these figures; the Dashboard adds **Forecast net sales today**.

**Exports.** Under **Insights → Exports**, people who can export reports download two files for other software. The **Sales and tax journal** has one line per business date and account code, debits and credits that balance each day: sales by menu category, discounts, comps, tax by category, tenders by type, tips, refunds and drawer over or short. Your bookkeeper maps the codes to their accounts. The **Payroll hours** file has regular and overtime hours per employee, position and work week; choose whole weeks (one to six), starting on the first day of your work week. It refuses while anyone's time entry in those weeks is still open, so close missed clock-outs first. Tip columns appear only if you can see tips. Neither file contains pay rates or pay.

### Your password and account security

- **Changing your password.** Choose **Change password** in the header, enter your current password, then the new one twice. It must be at least 14 characters and different from the current one. You stay signed in on this device, and every other device where you were signed in is signed out.
- **Too many wrong passwords.** After 5 wrong passwords within 15 minutes, sign-in is locked for 15 minutes. The message stays "Invalid email or password", even if you then type the right one. Wait, or ask an administrator to unlock the account.
- **After an administrator resets your password.** Sign in with the temporary password they give you. You go straight to **Change password**, and the app opens nothing else until you choose a new one.

### Taxes

Under **Admin → Taxes**, an owner or general manager adds tax categories (for example *Food* or *Alcohol*), sets each one's rate at this location (a new rate can start now or later; earlier sales keep the rate they were sent with), and switches tax on for the location. Tick **Menu prices already include this tax** on a rate when the menu price is tax-included (common for drinks): the app then takes the tax out of the price instead of adding it. Assign a category to each menu item on its page under **Tax category**. Once tax is on, an item with no category, or whose category has no rate here, can't be sent.

### Online booking

Managers open **Online booking** (the tab at the host stand) to let guests book on the restaurant's own page. The page's address is shown there; share it on your website.

- **Settings.** Turn **Take bookings online** on; choose whether to hold bookings until a host confirms them, the largest party guests can book online, how many guests may start in one time slot, the slot length (15, 30 or 60 minutes), how far ahead guests can book (at least, and at most), the reminder time (0 for none), and an optional note shown on the page.
- **Booking hours.** Add the hours, per day, when bookings may start, then **Save hours**. Guests see only times inside these hours that still have room. Hours on one day can't overlap.
- **What guests see.** The page asks for the date, party size, a time, their name, a mobile number or email, whether they want texts or emails about the booking, any food allergies in the party and special requests. They get a reference and a private link to view or cancel the booking; cancelling frees the time for others. A guest with two upcoming online bookings is asked to call. The page never shows other bookings, tables or staff.

### Notifications

The bell shows in-app notices for you: food and drinks ready, low stock, a published schedule with your shifts, an approved shift swap, a decision on your time off, a certification about to expire, being close to overtime this week, (for managers) a missed clock-out, and (for inventory managers) a lot about to expire or expired. Each notice appears once. Times everywhere in the app are shown in the restaurant's time zone, whatever your device is set to.

### Administration: users and System health

- **Locations.** Owners and General Managers open **Admin → Locations** to **Open a new location**: name, code and time zone, and optionally **Copy setup from** another location (settings, stations and kitchen routing, menus, prices, taxes, stocked items, scheduling and tip rules, booking hours). Staff, tables and stock are never copied; you get your own roles there. **Close location** is refused while anything is still open there (checks, seated parties, settlements, drawers, deliveries or transfers); **Reopen location** brings it back. The header always shows where you are working; with several locations it is a list. If you switch in one tab, a save in another tab still showing the old location is refused with a **Reload** button.
- **Someone from another location.** In **Admin → Users**, **Add an existing person** finds people already in the organization by email and gives them a role here.

- **Unlock an account.** In **Admin → Users**, a locked account shows **Locked until …**. Choose **Unlock** to end the lockout now; the password doesn't change.
- **Reset a password.** Choose **Reset password** on the user's card and confirm.
  - A temporary password appears **once**. Give it to the person directly; it can't be shown again.
  - The person is signed out everywhere and must choose a new password at next sign-in.
  - You can't reset your own password this way; use **Change password**.
- **System health.** Owners and General Managers open **Admin → System health**.
  - *What it shows:* how many realtime events are waiting, the oldest one's age, and any dead-lettered events, which are events delivery gave up on after repeated failures.
  - *Retry:* re-queues a dead-lettered event. An event only tells screens to refresh, so a dead-lettered one never blocks newer updates.
  - *Housekeeping:* published events are deleted automatically after 7 days. Order, kitchen, settlement and audit history is never deleted.
  - *Guest messages:* how many texts and emails are waiting to send, and how many failed. Retry a failed one from the reservation or waitlist card. After 90 days a message keeps its kind, status and time, but no longer its address or text.

## Common Questions

**Why is a page missing?** Navigation is based on your permissions at a location. Ask an administrator to review access; a hidden link is not a substitute for server-side authorization.

**What does "Reload" on an error mean?** Someone else changed the same record after you opened it. Choose **Reload** to see their change, then try again if it's still needed.

**Why can't I edit a sent item?** Draft items can be edited or removed. Once submitted, the item is retained as an operational record; use the authorized void workflow when appropriate.

**Why can't I complete a settlement?** Check for active draft items and an unpaid remaining balance. You may also lack settlement completion permission.

**Why is a closed check's table still occupied?** The table session has its own lifecycle. Complete the session after guests leave, then clean the table.

**Where is the audit history?** Users with audit access open **Audit** under **Insights**. Choose **Show** on an event to see each recorded field before and after the change, with changed fields highlighted.

## Current Scope Notes

- The application records settlement details but does not process payments.
- Loyalty is points only: no tiers, no points expiring, no birthday rewards, and guests can't see their balance online. There is no marketing. Messages to guests are about their own booking only: no newsletters or offers, and guests can't reply except STOP. Staff notifications stay in the app; staff get no texts or emails. Allergies apply to the whole party or check, not to one seat. Nutrition facts aren't shown.
- Online booking takes no deposits or card details, and isn't connected to OpenTable, Resy or similar services. Guests change a booking by cancelling and booking again, or by calling.
- Compound or stacked taxes, service charges and splitting a check evenly by amount aren't supported.
- A closed check can't be reopened; corrections after closing are refund records.
- The time clock and tip pool are record only: no payroll, pay stubs or tip payouts. Overtime is weekly, plus daily if a manager sets a daily threshold; both are your own settings, not a labor-law calculation.
- There is no "forgot password" email or reset link. An administrator resets passwords in the app.
- Full offline operation is not supported. If a request fails, check the displayed error and current record state before retrying a consequential action.

For system architecture and implementation requirements, see the [project README](../README.md).