-- 008: pay-rates tab — staffing roster + raise cycles/iterations/entries.
--
-- Per-seat pay rates ARE stored here (Troy, 2026-10-28 — explicit sign-off for
-- this feature; it supersedes the aggregate-only rule FOR THIS AREA ONLY. The
-- old payroll-model upload stays aggregate-only). Access is gated twice: the
-- payroll area has its own password on top of the app login, and seats in
-- Regional-Manager positions are masked for everyone outside RM_PAY_USERS.

create table if not exists staffing_snapshots (
  id serial primary key,
  upload_id int references uploads(id) on delete set null,
  label text not null default '',
  data jsonb not null default '{}'::jsonb,   -- {people:[{key,name,position,payMethod,payRate,monthlyBenefits,startDate,status,oldPay,allocations:[{code,pct}]}]}
  created_at timestamptz default now()
);

create table if not exists raise_cycles (
  id serial primary key,
  label text not null default '',
  effective text not null default '',        -- 'YYYY-MM' the raises take effect
  staffing_snapshot_id int references staffing_snapshots(id) on delete set null,
  created_by text not null default '',
  created_at timestamptz default now()
);

-- Each REGION (properties.market) runs its own iteration chain inside a cycle
-- (Troy, 2026-10-29): Minot can finalize #2 while Bismarck is still on #1.
create table if not exists raise_iterations (
  id serial primary key,
  cycle_id int not null references raise_cycles(id) on delete cascade,
  region text not null default '',
  num int not null,
  based_on int references raise_iterations(id) on delete set null,
  prop_status jsonb not null default '{}'::jsonb,   -- code -> {status, by, at}
  created_by text not null default '',
  created_at timestamptz default now(),
  finalized_by text,
  finalized_at timestamptz,
  unique (cycle_id, region, num)
);

create table if not exists raise_entries (
  iteration_id int not null references raise_iterations(id) on delete cascade,
  person_key text not null,
  raise_pct numeric not null default 0,
  updated_by text not null default '',
  updated_at timestamptz default now(),
  primary key (iteration_id, person_key)
);

-- A regional manager's covered property codes (admin-set in Settings).
-- Empty = not scoped; non-admins with no sites see no payroll data.
alter table app_users add column if not exists sites jsonb not null default '[]'::jsonb;
