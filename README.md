# nd-budget-tool

Property budgeting web app for Monarch ND — replaces the FHND/PHND-style Excel budget workbooks.

**Mode 1 (live): new-acquisition budgets.** Built from three uploads:
1. **UW book model** (.xlsx, AGM BOOK MODEL) — the tie-out target. Year-1 pro forma per property, by P-code category.
2. **Rent roll** (Yardi multi-property summary or OneSite RENT ROLL DETAIL) — GPR anchors to market rents; loss-to-lease starts at the actual market-vs-in-place gap and burns off to the UW %.
3. **Property comparison** (Yardi export, e.g. Minot 4) — comp set that distributes each UW category total across detail GLs in proportion to comparable properties' spending.

Expense categories tie to the UW **exactly** (penny-exact allocation); income anchors to the rent roll with UW variance shown. Manual cell edits become overrides (purple, 🔓 to release); the **tie** button re-scales a category's non-overridden lines back to target. Seasonal curves (snow, heat, electric, summer, turnover) spread annual amounts across months.

**Outputs:**
- **Yardi Voyager budget CSV** — byte-exact ETL format (`//Budget` + `//BudgetDetail`, full 335-account chart in canonical order). Mid-year revisions zero out actualized months via the cutoff selector.
- **Excel review workbook** — Budget grid with live formulas, Summary vs UW, Raw Data audit sheet.

**Mode 2 (planned): annual budgets** from coded historicals. Note: the Yardi *Budget Worksheet* export carries only the prior-year annual budget — monthly actuals need a 12-month income statement / property comparison (Actual book) export.

## Stack

Node 20 + TypeScript + Express + PostgreSQL, vanilla-JS SPA, SheetJS for Excel I/O. Same conventions as SP Tracker (sessions in Postgres, shared password + username, `ADMIN_USERS` allowlist, `migrations/*.sql` applied on boot, first-boot seed).

## Dev

```
npm install
copy .env.example .env    # set DATABASE_URL (local: postgres://postgres:postgres@localhost:5432/budget_tool)
npm run dev               # http://localhost:3100
npm test                  # vitest — engines + importers + CSV round-trip vs real fixture files
npm run typecheck
```

Test fixtures (`test/fixtures/*.xlsx|csv`) are the real Bismarck/Jamestown UW books, rent roll, Minot 4 comparison, and PHND revision CSV — gitignored; copy them in locally to run the importer tests.

## Deploy (Railway)

Service from this repo + Postgres plugin. Env: `DATABASE_URL` (from plugin), `APP_PASSWORD`, `SESSION_SECRET`, `ADMIN_USERS`, `NODE_ENV=production`. `railway.json` health-checks `/healthz`; migrations + seed run on boot.

See `PROJECT_MAP.md` for architecture detail.
