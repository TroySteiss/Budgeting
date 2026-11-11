-- 015: fixes from the 2027 Budget notes review (Troy 2026-11-11, agreed).
-- (Keep this file ASCII: a local WIN1252 database rejects other characters.)
-- 1. 6934 SNOW REMOVAL CONTRACTOR: snow contracts bill flat monthly Nov 1 - Apr 30, so its curve
--    is the new snowContract curve. 6818 SNOW REMOVAL (supplies, ice melt) keeps the weather curve.
--    Only a GL still on the seeded 'snow' curve moves; a curve an admin picked is kept.
update gl_accounts set curve = 'snowContract' where code = '6934' and curve = 'snow';
-- 2. 6381 is the regional / portfolio events GL (Ribfest goes here, split by units; KB A1). The
--    seed carried an old name. Display only: the Yardi CSV carries no account names.
update gl_accounts set name = 'ANNUAL REGIONAL/PORTFOLIO EVENTS' where code = '6381' and name = 'ANNUAL MI FISH FRY';
-- 3. CLND is 340 units per BoxScore 9/28 and 11/2 (KB A1 Reference figures; the seed had 341).
--    Budgets keep the units saved on them; this changes the property record only.
update properties set units = 340 where code = 'clnd' and units = 341;
