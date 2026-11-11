-- 016: required budget lines (Troy 2026-11-11, from the 2027 Budget notes review). A per-region list
-- of GLs every annual budget must carry; the editor flags a budget where one is zero (Defaults in
-- use, and before a Yardi export). Admins edit it under Settings.
-- (Keep this file ASCII: a local WIN1252 database rejects other characters.)
alter table app_meta add column if not exists required_lines jsonb not null default '[]'::jsonb;
-- North Dakota only (the schema that holds the ND sites): annual fire inspections at every site,
-- in the correct GL (Riley Combs 2026-08-26; April 2027 inspections, Riley 2026-10-16).
update app_meta set required_lines = '[{"gl":"6917","why":"Annual fire inspection at every site (Riley Combs 2026-08-26; April 2027 inspections)"}]'::jsonb
where id = 1 and required_lines = '[]'::jsonb and exists (select 1 from properties where code = 'bcnd');
