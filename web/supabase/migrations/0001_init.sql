-- Pantry scanner schema.
--
-- The server reaches these tables only with the service-role key, which
-- bypasses row-level security. RLS is switched on with no policies so the
-- public anon key -- which ships to every browser -- can read nothing.

create table if not exists products (
  barcode    text primary key,
  name       text not null,
  brand      text not null default '',
  size       text not null default '',
  image_url  text not null default '',
  source     text not null default 'off' check (source in ('off', 'manual', 'unknown')),
  updated_at timestamptz not null default now()
);

create table if not exists pantry (
  barcode    text primary key,
  name       text not null,
  brand      text not null default '',
  size       text not null default '',
  qty        integer not null default 0 check (qty >= 0),
  first_seen timestamptz not null default now(),
  last_seen  timestamptz not null default now()
);

create table if not exists scan_log (
  id        bigint generated always as identity primary key,
  ts        timestamptz not null default now(),
  direction text not null check (direction in ('in', 'out')),
  barcode   text not null,
  name      text not null,
  qty_after integer not null,
  source    text not null default 'scanner',
  undone_at timestamptz
);

-- Undo always wants the newest row that has not been undone yet.
create index if not exists scan_log_active on scan_log (id desc) where undone_at is null;

create table if not exists cart_queue (
  id                  bigint generated always as identity primary key,
  ts                  timestamptz not null default now(),
  barcode             text not null,
  name                text not null,
  qty                 integer not null default 1 check (qty >= 0),
  status              text not null default 'pending'
                        check (status in ('pending', 'done', 'failed', 'cancelled')),
  frisco_product_id   text,
  frisco_product_name text,
  note                text
);

-- Repeat out-scans bump the pending row rather than adding another one.
create unique index if not exists cart_queue_one_pending
  on cart_queue (barcode) where status = 'pending';

alter table products   enable row level security;
alter table pantry     enable row level security;
alter table scan_log   enable row level security;
alter table cart_queue enable row level security;
