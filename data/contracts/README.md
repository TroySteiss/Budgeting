# Contracts register: repo files

One CSV per region and budget year: `nd/2027.csv`, `kc/2027.csv`. On every deploy the server loads each file into the
region's contracts register (the Contracts page) and recalculates the budgets of every property and year that changed.

- A row's identity is **property + year + GL + vendor**. The same identity on the page (typed earlier, or migrated from a
  budget's own list) is updated from the file, unless it was changed on the page after the file loaded it: then the
  page's version wins and the file row is skipped.
- A row the file loaded and no longer lists is removed (never one changed on the page).
- Rows added on the page are never touched by the file.
- A row with a problem (bad GL, no amount, unknown kind) is skipped and logged; the rest load.

Columns (header row; any order; blank = not set):

| column | what |
|---|---|
| property | site code: clnd, cwnd, ... |
| gl | the GL it books to |
| vendor | who it is with |
| kind | monthly, annual or perUnit (default monthly) |
| amount | $ per month (monthly), the invoice (annual), $ per unit (perUnit); with per = total, the whole for the months |
| per | month or total (monthly only) |
| months | months billed, 1-12, separated by `;` (blank = every month) |
| bill_month | the invoice month, 1-12 (annual) |
| step_month / step_pct | a price change from that month, in % (3 = +3%) |
| mode | replace (the line becomes its contracts) or add (on top of the line's formula); default replace |
| note | free text |
| whole_gl | `yes` = the file's rows are the whole GL for that property and year: contracts on that GL from the review workbook or carried over from a budget's own list are removed on every deploy. Rows added or changed on the page stay, and the deploy log names them |

Gutter contracts always bill in March and November, whatever months are typed (engine rule).
