-- 001: full initial schema for nd-budget-tool

-- express-session store (connect-pg-simple, createTableIfMissing:false)
create table if not exists session (
  sid varchar not null primary key,
  sess json not null,
  expire timestamp(6) not null
);
create index if not exists idx_session_expire on session(expire);

create table if not exists app_meta (
  id int primary key default 1,
  app_title text default 'Budget Tool'
);
insert into app_meta(id) values(1) on conflict do nothing;

create table if not exists app_users (
  key text primary key,
  display text default '',
  role text default 'user',
  last_seen timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists portfolios (
  id serial primary key,
  name text unique not null,
  kind text not null default 'subject'          -- subject | comp
);

create table if not exists properties (
  code text primary key,                        -- lowercase Yardi code (cwnd, drnd, ...)
  name text not null default '',
  units int not null default 0,
  market text not null default '',
  portfolio_id int references portfolios(id) on delete set null,
  role text not null default 'subject',         -- subject | comp
  created_at timestamptz default now()
);

create table if not exists gl_accounts (
  code text primary key,
  name text not null default '',
  kind text not null default 'detail',          -- detail | header | total
  section text not null default '',
  pcode text,                                   -- UW category: 1 loss 2..14, null = below-the-line
  csv_order int,                                -- position in the Yardi upload CSV (null = not uploadable)
  display_order int not null default 0,
  curve text default 'flat',                    -- monthly spread curve name
  active boolean not null default true
);

create table if not exists uploads (
  id serial primary key,
  kind text not null,                           -- uw_book | rent_roll | comparison
  filename text not null default '',
  uploaded_by text not null default '',
  uploaded_at timestamptz default now(),
  payload jsonb not null default '{}'::jsonb
);

create table if not exists uw_snapshots (
  id serial primary key,
  property_code text not null references properties(code) on delete cascade,
  upload_id int references uploads(id) on delete set null,
  label text not null default '',
  data jsonb not null default '{}'::jsonb,      -- {units, unitMix, y1:{pcode:amount}, assumptions, egi, toe, noi, t12}
  created_at timestamptz default now()
);

create table if not exists comp_sets (
  id serial primary key,
  name text not null,
  upload_id int references uploads(id) on delete set null,
  period text not null default '',
  book text not null default '',
  data jsonb not null default '{}'::jsonb,      -- {properties:[code], rows:[{gl, name, values:[...], total}]}
  created_at timestamptz default now()
);

create table if not exists rent_snapshots (
  id serial primary key,
  property_code text not null references properties(code) on delete cascade,
  upload_id int references uploads(id) on delete set null,
  as_of date,
  data jsonb not null default '{}'::jsonb,      -- {units, marketMonthly, inPlaceMonthly, occupiedUnits, source}
  created_at timestamptz default now()
);

create table if not exists budgets (
  id serial primary key,
  property_code text not null references properties(code) on delete cascade,
  year int not null,
  label text not null default '',
  budget_type text not null default 'new_acq',  -- new_acq | annual | revision
  status text not null default 'draft',
  inputs jsonb not null default '{}'::jsonb,    -- income assumptions, loan, capital, curves, etc.
  uw_snapshot_id int references uw_snapshots(id) on delete set null,
  comp_set_id int references comp_sets(id) on delete set null,
  rent_snapshot_id int references rent_snapshots(id) on delete set null,
  created_by text not null default '',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists budget_lines (
  budget_id int not null references budgets(id) on delete cascade,
  gl_code text not null references gl_accounts(code),
  months jsonb not null default '[0,0,0,0,0,0,0,0,0,0,0,0]'::jsonb,
  driver jsonb not null default '{}'::jsonb,    -- {method, ...params}
  override boolean not null default false,
  note text not null default '',
  primary key (budget_id, gl_code)
);

create table if not exists change_log (
  id serial primary key,
  at timestamptz default now(),
  username text not null default '',
  action text not null default '',
  detail jsonb not null default '{}'::jsonb
);
