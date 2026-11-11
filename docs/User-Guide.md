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

The check on the right stays in view while you scroll the menu. It shows how many items are not sent yet and the running total of what has been sent.

**Courses.** When adding an item, choose its **Course** (1 to 5). If the drafts span more than one course, **Send & hold courses …** sends everything now but only the first course goes to the kitchen. The later courses wait under **Held courses** until you choose **Fire course _N_**. Held food is already counted against inventory, because it was ordered.

**Splitting the bill.** Choose **Move items**, tick the items (sent or not), and pick **A new check at this table** or another open check at the same table. Prices, discounts on those items and their kitchen progress go with them; discounts on the whole check stay on it. A check that is being settled can't be split until its settlement is cancelled.

Submitted items are historical records. To void one, choose **Void item** on it: a window asks for a reason and whether it was prepared, and for a final confirmation. Choose **Not prepared** only when it was not prepared; prepared or discarded food remains consumed.

### 4. Prepare and fulfill submitted items

1. Kitchen staff open **Kitchen Queue**; bar staff open **Bar Queue**. **Expo** provides a combined, read-only view.
2. Use the status, order type, and prep-station filters to focus the queue.
3. For each item, select **Start**, then **Ready**, then **Complete** as work progresses. The queue refreshes automatically.
4. If an item needs to be remade, enter a reason and choose **Remake**. A remake creates fulfillment work; it does not automatically restore consumed inventory.

Modifier preparation notes and special instructions are shown with the ticket. The status for an individual station may differ from the overall item status while other stations are still working.

Held courses stay off the kitchen and bar queues until they are fired; Expo lists them as **Held**. A fired ticket shows its course.

Each ticket shows how long it has waited (counted from when its course was fired). Its border and header turn amber after 10 minutes and red, marked **Late**, after 20. **New-ticket sound** plays a short chime when a new ticket arrives; it is off until you turn it on, and the choice is remembered on that device only.

### 5. Record settlement and close the check

1. From the selected order, choose **Settlement**.
2. Choose **Open Settlement** if one is not already open.
3. Record each tender using the permitted tender type. For cash, enter the amount applied, tip, and cash received, and choose the **Cash drawer** it went into. Split payments can be recorded as multiple tenders.
4. Confirm the remaining balance, shown in large type, and tips. **Cash – exact** and **Card – exact** fill in the remaining amount for you. Submit or remove any draft items before completing.
5. When the balance is fully settled, choose **Complete Settlement and close Order**.

Settlement is record-keeping only. The app does not charge or authorize cards; any card transaction must be processed in an external system first. You may record safe external references when permitted, but never enter a full card number, security code, PIN, or bank details. The amount due is the subtotal plus tax, where the location charges tax.

**Refunds.** A manager can record money given back to a guest on a closed check, under **Refunds** on its settlement screen: what it was refunded as, the amount (with the tax part), and a reason. Give the money back outside the app first. The check stays closed; the refund counts on the day it is given. A mistaken refund can be voided with a reason.

### Cash drawers

Open **Cash drawers**. A manager opens a drawer with its **Starting float** at the start of a shift and records any **Paid in** or **Paid out** with a reason. At the end, enter **Cash counted** and choose **Close drawer**: the app shows the expected cash (float, plus cash taken with tips and paid in, less paid out and cash refunds) and the variance (counted minus expected). A drawer can't close while a check with cash in it is still being settled. Where the location requires a drawer, cash can't be recorded until one is open.

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

### Clocking in and out

Open **My time** and choose **Clock in** at the start of your shift. If you hold more than one position here, choose the one you're working. **Start unpaid break** and **End break** record a break; unpaid break time isn't counted as worked. Choose **Clock out** when you leave; an open break ends at the same moment. The page shows this week's entries, your hours so far against the overtime threshold (**On track**, **Near overtime** or **In overtime**), and your finalized tip shares for the last 30 days. Your login must be linked to your employee record; if it isn't, a manager can clock you in instead.

### Time clock (managers)

Open **Time clock** to see who is on the clock now, with each person's hours this week and overtime state. Managers can:

- **Clock someone in** who has no login, or **Clock out** anyone on the clock. Both are recorded in the audit trail.
- Fix a **missed clock-out**. An entry still open from an earlier day counts no hours until it's closed. Open **Adjust or void**, enter the clock-out time and a reason, and save.
- Correct any entry's times or position under **Adjust or void**. Blank fields stay as they are, and a reason is always required. The original punch times are kept with the correction.
- **Void** an entry made by mistake. It stays on record but counts nowhere.

Choose a date to see that day's entries; adjusted entries are marked **Adjusted**. Someone who is on the clock can't be terminated until they're clocked out.

### Tips

Open **Tips** (managers). Under **Tip pool**, switch pooling on and give points to each position that shares tips, for example Server 10 and Busser 5. Leave a position blank to leave it out. For a business date, the page shows the cash and card tips from closed checks and how they would be shared: hours worked × points. Choose **Finalize tips** once every check is closed and everyone is clocked out. The shares are then saved as they are, and that day's hours can't change. To redo a day, **Void distribution** with a reason, fix what's wrong, then finalize again. Tips are recorded here only; pay them out outside the app.

### Employees

Open **Employees** to view or manage employee records according to your permissions. Sensitive HR details such as compensation, disciplinary information, personal addresses, and emergency contacts are restricted separately from ordinary employee information. Employee job positions describe restaurant work; they do not grant application access.

### Menu and recipes

Open **Menu** to review currently available, priced menu items and their modifiers. Users with configuration access can choose **Configure menu** or open **Menu & Recipes** to manage menu and recipe data. Orders already submitted retain their recorded item, price, modifier, and recipe-related snapshots when configuration later changes.

### Inventory and purchasing

Open **Inventory & Purchasing** to review stock, low-stock items, and inventory transactions. Depending on your permissions, the workspace also supports counts, adjustments, purchasing, receiving, and inventory configuration.

Receiving goods changes on-hand inventory; creating a purchase order by itself does not. Inventory changes are recorded as transactions. Use the inventory workflows rather than attempting to correct stock outside the app, so the stock balance and movement history stay aligned.

### Reporting

Open **Reporting**, choose an available report, and set the date range. Which reports and export actions appear depends on your permissions. Reports use the selected location and operational business dates; an early-morning clock time may belong to the previous restaurant business date.

The **Labor** report shows scheduled labor first, then actual labor from the time clock: worked hours, regular and overtime hours, scheduled vs. actual by day (late, early out, unscheduled, no-show), overtime by work week, and time clock exceptions (missed clock-outs, corrections, voids). Labor cost appears only for people allowed to see compensation. The **Tips** report shows tips by date and tender, direct tips by server, and finalized tip shares.

### Your password and account security

- **Changing your password.** Choose **Change password** in the header, enter your current password, then the new one twice. It must be at least 14 characters and different from the current one. You stay signed in on this device, and every other device where you were signed in is signed out.
- **Too many wrong passwords.** After 5 wrong passwords within 15 minutes, sign-in is locked for 15 minutes. The message stays "Invalid email or password", even if you then type the right one. Wait, or ask an administrator to unlock the account.
- **After an administrator resets your password.** Sign in with the temporary password they give you. You go straight to **Change password**, and the app opens nothing else until you choose a new one.

### Taxes

Under **Admin → Taxes**, an owner or general manager adds tax categories (for example *Food* or *Alcohol*), sets each one's rate at this location (a new rate can start now or later; earlier sales keep the rate they were sent with), and switches tax on for the location. Assign a category to each menu item on its page under **Tax category**. Once tax is on, an item with no category, or whose category has no rate here, can't be sent.

### Administration: users and System health

- **Unlock an account.** In **Admin → Users**, a locked account shows **Locked until …**. Choose **Unlock** to end the lockout now; the password doesn't change.
- **Reset a password.** Choose **Reset password** on the user's card and confirm.
  - A temporary password appears **once**. Give it to the person directly; it can't be shown again.
  - The person is signed out everywhere and must choose a new password at next sign-in.
  - You can't reset your own password this way; use **Change password**.
- **System health.** Owners and General Managers open **Admin → System health**.
  - *What it shows:* how many realtime events are waiting, the oldest one's age, and any dead-lettered events, which are events delivery gave up on after repeated failures.
  - *Retry:* re-queues a dead-lettered event. An event only tells screens to refresh, so a dead-lettered one never blocks newer updates.
  - *Housekeeping:* published events are deleted automatically after 7 days. Order, kitchen, settlement and audit history is never deleted.

## Common Questions

**Why is a page missing?** Navigation is based on your permissions at a location. Ask an administrator to review access; a hidden link is not a substitute for server-side authorization.

**Why can't I edit a sent item?** Draft items can be edited or removed. Once submitted, the item is retained as an operational record; use the authorized void workflow when appropriate.

**Why can't I complete a settlement?** Check for active draft items and an unpaid remaining balance. You may also lack settlement completion permission.

**Why is a closed check's table still occupied?** The table session has its own lifecycle. Complete the session after guests leave, then clean the table.

**Where is the audit history?** Users with audit access open **Audit** under **Insights**. Choose **Show** on an event to see each recorded field before and after the change, with changed fields highlighted.

## Current Scope Notes

- The application records settlement details but does not process payments.
- Tax is added on top of menu prices. Tax-inclusive prices, tax exemptions and compound taxes aren't supported.
- A closed check can't be reopened; corrections after closing are refund records.
- The time clock and tip pool are record only: no payroll, pay stubs or tip payouts. Overtime is weekly only and is your own setting, not a labor-law calculation.
- There is no "forgot password" email or reset link. An administrator resets passwords in the app.
- Full offline operation is not supported. If a request fails, check the displayed error and current record state before retrying a consequential action.

For system architecture and implementation requirements, see the [project README](../README.md).