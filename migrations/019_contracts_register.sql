-- 019: the contracts register (Troy 2026-11-17: "I need a significantly better way to alter contract expenses per year
-- that you can push data directly into, as can I without doing a whole upload and overwrite"). One row per contract per
-- property per budget year, edited row by row on the Contracts page (or the per-budget Contracts dialog), or pushed from
-- data/contracts/<region>/<year>.csv in the repo on deploy. Every budget of that property and year reads its contracts
-- from here; budgets.inputs.contracts is no longer the source (it is kept as it was).
-- `data` holds the contract as the engine reads it (shared/domain.ts Contract). `origin`: ui | repo | review | migrated.
-- `repo_hash` = the repo row's content when it was last loaded; `ui_edited` = changed on the page since (the page wins).
-- (Keep this file ASCII: a local WIN1252 database rejects other characters.)
create table if not exists contracts (
  id text primary key,
  property_code text not null,
  year int not null,
  gl text not null,
  vendor text not null default '',
  data jsonb not null,
  origin text not null default 'ui',
  repo_hash text,
  ui_edited boolean not null default false,
  updated_by text not null default '',
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists contracts_prop_year on contracts (lower(property_code), year);

-- every budget's own list moves in once: the latest budget of each property and year wins; a contract kept on two
-- budgets of the same property and year (iterations) comes in once
insert into contracts (id, property_code, year, gl, vendor, data, origin)
select distinct on (s.property_code, s.year, s.cid)
       lower(s.property_code) || ':' || s.year || ':' || s.cid,
       lower(s.property_code), s.year, coalesce(s.c->>'gl', ''), coalesce(s.c->>'vendor', ''), s.c,
       case when s.c ? 'review' then 'review' else 'migrated' end
  from (
    select b.property_code, b.year, b.updated_at, x.c,
           coalesce(nullif(x.c->>'id', ''), 'm' || b.id || '-' || x.ord) as cid
      from budgets b,
           jsonb_array_elements(case when jsonb_typeof(b.inputs->'contracts') = 'array' then b.inputs->'contracts' else '[]'::jsonb end)
             with ordinality as x(c, ord)
  ) s
 where coalesce(s.c->>'gl', '') <> ''
 order by s.property_code, s.year, s.cid, s.updated_at desc
on conflict (id) do nothing;
