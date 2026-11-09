# nd-budget-tool: Claude Code notes

Budgeting web app. Replaces the FHND/PHND Excel budget workbooks for new acquisitions
(Bismarck 4: CWND LHND NRND RRND; Jamestown 2: DRND MWND); annual-budget mode is planned.
Node + TypeScript + Express + Postgres, vanilla-JS SPA.

- Read PROJECT_MAP.md first and keep it current (KB page: `Claude KB\Tools\nd-budget-tool.md`).
  Also see HANDOFF.md and DEVILS_ADVOCATE_2026-11-05.md.
- Remote: github.com/TroySteiss/Budgeting, branch main. Railway deploys on push.
- All business math lives in `shared/domain.ts` (pure, unit-tested). Local: `npm run dev` (port 3100)
  or launch config "budget".
- Never auto-adjust a line Troy didn't pick. A tie touches only the selected line or category; leftover
  gaps stay visible as variance. Don't change a budget's saved absorber/basis settings unasked.
- Seller T12s set the monthly shape (when money is spent), never dollar levels. Levels come from the
  UW tie-out, distributed by Minot-comp per-GL weights (`T12_SHAPE_PCODES`).
- The Yardi budget CSV export is byte-exact against a real upload file; keep it that way.
- The Pay-rates tab holds compensation data. Never copy figures into docs, commits or the KB.
- Workspace guide and KB pointer: `C:\SP Automation\CLAUDE.md`.
