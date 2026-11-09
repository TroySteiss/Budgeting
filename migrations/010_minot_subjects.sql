-- 010: the Minot sites were seeded as comps (they supply the comp weights for the Bismarck and
-- Jamestown acquisition budgets), which hid them from the dashboard Properties card and the New
-- budget dialog. They are budgeted here too (Troy 2026-11-09), so they become subjects. The role
-- only drives those lists: comp sets and existing budgets are untouched. tpndc (the 0-unit
-- commercial entry) stays a comp. Admins can change a role under Settings, Properties.
-- (Keep this file ASCII: a local WIN1252 database rejects other characters.)
update properties set role = 'subject' where code in ('clnd', 'spnd', 'tcnd', 'tpnd', 'wynd') and role = 'comp';
