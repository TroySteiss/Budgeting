-- 7491 SP INTEREST INCOME carried display_order 107491 (seed anomaly), which
-- pushed it below NET PROFIT/LOSS — and made the review workbook's
-- TOTAL SPECIAL PROJECT EXP SUM span the whole bottom of the sheet.
update gl_accounts set display_order = 409 where code = '7491' and display_order > 1000;
