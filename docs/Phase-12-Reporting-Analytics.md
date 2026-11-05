# Phase 12: Reporting, Analytics & Operational Insights

## Purpose

Phase 12 introduces operational reporting, analytics, dashboards, and historical business insight capabilities.

The purpose of this phase is to transform the transactional data created in Phases 1–11 into actionable business intelligence while preserving all domain boundaries and historical accuracy.

Before implementation:

1. Read README.md.
2. Read .github/copilot-instructions.md.
3. Read docs/accepted-risks.md.
4. Read all Phase 0–11 implementation plans.
5. Read all Phase 0–11 completion reports.
6. Derive current system behavior from source code, migrations, tests, and committed documentation.
7. Treat README.md as the architectural source of truth.

## Objectives

Implement:

- Sales Reporting
- Settlement Reporting
- Order Analytics
- Inventory Analytics
- Fulfillment Analytics
- Labor Analytics
- Seating Analytics
- Operational Dashboards
- CSV Export

## Architectural Principle

Phase 12 is read-only.

Reporting consumes historical data from Orders, Order Items, Submitted Snapshots, Fulfillment History, Inventory Ledger, Settlements, Tenders, Employees, Schedules, Table Sessions, Reservations, and Waitlists.

Reports must never modify Orders, Settlements, Tenders, Inventory, Fulfillment, Table Sessions, Reservations, or Schedules.

## Reporting Domains

1. Sales Reporting
2. Settlement Reporting
3. Order Reporting
4. Menu Sales Reporting
5. Inventory Reporting
6. Fulfillment Reporting
7. Labor Reporting
8. Seating Analytics

## Dashboard

Provide reporting dashboards filtered by:

- Business Date
- Date Range
- Location

## Authorization

Expected permissions:

- reports.view
- reports.sales
- reports.orders
- reports.inventory
- reports.fulfillment
- reports.labor
- reports.settlements
- reports.seating
- reports.export

## CSV Export

Support CSV export only in Phase 12.

## Definition of Done

Users can view operational analytics, filter by Business Date and Location, export CSV reports, and analyze sales, settlements, inventory, fulfillment, labor, and seating while preserving all prior phase boundaries.

## Required Phase 12 Completion Report

A mandatory Phase 12 Completion Report must be produced at completion. The report must document:

- Environment
- Reporting Domain Results
- Export Results
- Authorization Results
- Data Integrity Validation
- Performance Validation
- Full Validation Suite Results
- Regression Results
- Security Review
- Files Changed
- Architecture Deviations
- Outstanding Issues
- Accepted Risks
- Next-Phase Readiness

## Recommended Copilot Prompt

Read README.md, .github/copilot-instructions.md, docs/accepted-risks.md, docs/Phase-12-Reporting-Analytics.md, and all Phase 0–11 implementation plans and completion reports.

Treat README.md as the architectural source of truth.

Review repository source, migrations, tests, indexes, APIs, permissions, and documentation before editing.

Provide a concise implementation plan before coding.

Implement Phase 12 only: Reporting, Analytics, Dashboard, CSV Export, Reporting RBAC, Tests, and Documentation.

After implementation, run the full validation suite and provide the complete Phase 12 Completion Report.
