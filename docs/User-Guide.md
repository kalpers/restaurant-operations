# Restaurant Operations App: User Guide

This guide walks restaurant staff and managers through the workflows currently available in the application. Your available pages and actions depend on your account permissions and assigned location.

## Before You Begin

Sign in at the application URL provided by your administrator using your restaurant account. The navigation is permission-filtered: if a page or action described here is missing, ask an administrator to check your account's location access and permissions.

The Overview page is currently a placeholder. Use the navigation to open the operational workspace you need. The Phase 13 validation seed creates test records, but it does **not** create a demo login account.

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
3. Select a menu category and item. Choose the required modifiers, enter quantity, and add any kitchen instructions.
4. Review the price preview and choose **Add Draft Item**. Repeat for more items.
5. Review the draft list. Use **Edit** to change a draft item or **Remove** to remove it before sending.

Draft items are not sent to the kitchen or bar and do not consume inventory. When the guest's current round is ready, choose **Submit _N_ Items**. Submission records the item and price snapshots, posts applicable inventory consumption, and creates fulfillment tickets. Add later rounds as new drafts and submit them separately.

Submitted items are historical records. Voiding one requires a disposition and reason. Choose **Unprepared** only when it was not prepared; prepared or discarded food remains consumed.

### 4. Prepare and fulfill submitted items

1. Kitchen staff open **Kitchen Queue**; bar staff open **Bar Queue**. **Expo** provides a combined, read-only view.
2. Use the status, order type, and prep-station filters to focus the queue.
3. For each item, select **Start**, then **Ready**, then **Complete** as work progresses. The queue refreshes automatically.
4. If an item needs to be remade, enter a reason and choose **Remake**. A remake creates fulfillment work; it does not automatically restore consumed inventory.

Modifier preparation notes and special instructions are shown with the ticket. The status for an individual station may differ from the overall item status while other stations are still working.

### 5. Record settlement and close the check

1. From the selected order, choose **Settlement**.
2. Choose **Open Settlement** if one is not already open.
3. Record each tender using the permitted tender type. For cash, enter the amount applied, tip, and cash received. Split payments can be recorded as multiple tenders.
4. Confirm the remaining balance and tips. Submit or remove any draft items before completing.
5. When the balance is fully settled, choose **Complete Settlement and close Order**.

Settlement is record-keeping only. The app does not charge or authorize cards; any card transaction must be processed in an external system first. You may record safe external references when permitted, but never enter a full card number, security code, PIN, or bank details. Tax calculation is not currently included, and the displayed order obligation is pre-tax.

### 6. Complete the table session and clean the table

Closing the order does not free the table. After the guests leave, return to **Restaurant floor**, choose **Complete session**, then mark the table clean after it has been cleaned. The table becomes available only when the session is complete and the physical table is clean.

## Other Workspaces

### Scheduling

Open **Scheduling** to review schedule periods. Users with schedule-edit access can create a period and manage its shifts and assignments. Where enabled, automatic generation creates a **draft** schedule: review coverage, warnings, and assignments, make corrections, then publish it explicitly. Generation never publishes automatically.

**My schedule** is the employee self-service area for availability and scheduling requests. **Scheduling requests** is for authorized reviewers to process requests. **Staffing & rules** is for users who manage staffing templates and scheduling rules.

### Employees

Open **Employees** to view or manage employee records according to your permissions. Sensitive HR details such as compensation, disciplinary information, personal addresses, and emergency contacts are restricted separately from ordinary employee information. Employee job positions describe restaurant work; they do not grant application access.

### Menu and recipes

Open **Menu** to review currently available, priced menu items and their modifiers. Users with configuration access can choose **Configure menu** or open **Menu & Recipes** to manage menu and recipe data. Orders already submitted retain their recorded item, price, modifier, and recipe-related snapshots when configuration later changes.

### Inventory and purchasing

Open **Inventory & Purchasing** to review stock, low-stock items, and inventory transactions. Depending on your permissions, the workspace also supports counts, adjustments, purchasing, receiving, and inventory configuration.

Receiving goods changes on-hand inventory; creating a purchase order by itself does not. Inventory changes are recorded as transactions. Use the inventory workflows rather than attempting to correct stock outside the app, so the stock balance and movement history stay aligned.

### Reporting

Open **Reporting**, choose an available report, and set the date range. Which reports and export actions appear depends on your permissions. Reports use the selected location and operational business dates; an early-morning clock time may belong to the previous restaurant business date.

## Common Questions

**Why is a page missing?** Navigation is based on your permissions at a location. Ask an administrator to review access; a hidden link is not a substitute for server-side authorization.

**Why can't I edit a sent item?** Draft items can be edited or removed. Once submitted, the item is retained as an operational record; use the authorized void workflow when appropriate.

**Why can't I complete a settlement?** Check for active draft items and an unpaid remaining balance. You may also lack settlement completion permission.

**Why is a closed check's table still occupied?** The table session has its own lifecycle. Complete the session after guests leave, then clean the table.

**Where is the audit history?** Audit viewing is not currently available in the application, even though the broader system architecture describes an audit capability.

## Current Scope Notes

- The Overview page is a placeholder; use the individual workspaces.
- The application records settlement details but does not process payments.
- Tax calculation is deferred; settlement amounts shown are pre-tax.
- The audit workspace and audit verification are not implemented.
- Full offline operation is not supported. If a request fails, check the displayed error and current record state before retrying a consequential action.

For system architecture and implementation requirements, see the [project README](../README.md).