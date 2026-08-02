-- TOHO池袋店 店長ダッシュボード 初期スキーマ（設計書 §4 準拠）
-- Supabaseプロジェクト作成後、SQL Editorで実行する。

create extension if not exists pgcrypto;

-- ---------- マスタ ----------
create table if not exists store (
  id text primary key,
  name text not null,
  fiscal_start_month smallint not null default 4,
  created_at timestamptz default now()
);

create table if not exists section_def (
  id uuid primary key default gen_random_uuid(),
  store_id text not null references store(id),
  key text not null,
  label text not null,
  ptype text not null check (ptype in ('S','P')),
  rate numeric(8,4) not null,
  sort_order smallint not null,
  is_active boolean not null default true,
  updated_at timestamptz default now(),
  unique (store_id, key)
);

-- ---------- 予実系 ----------
create table if not exists budget_year (
  store_id text not null references store(id),
  fy smallint not null,
  section_id uuid not null references section_def(id),
  sales numeric(14,0), gross numeric(14,0), out_total numeric(14,0),
  updated_at timestamptz default now(),
  primary key (store_id, fy, section_id)
);

create table if not exists budget_month (
  store_id text not null references store(id),
  fy smallint not null,
  month smallint not null check (month between 1 and 12),
  section_id uuid not null references section_def(id),
  sales numeric(14,0), gross numeric(14,0), out_total numeric(14,0),
  updated_at timestamptz default now(),
  primary key (store_id, fy, month, section_id)
);

create table if not exists machines_day (
  store_id text not null references store(id),
  ymd date not null,
  section_id uuid not null references section_def(id),
  count smallint not null,
  updated_at timestamptz default now(),
  primary key (store_id, ymd, section_id)
);
create index if not exists idx_machines_day on machines_day (store_id, ymd);

create table if not exists plan_day (
  store_id text not null references store(id),
  ymd date not null,
  section_id uuid not null references section_def(id),
  out_per_unit numeric(10,1),
  unit_price numeric(8,4),
  gross_rate numeric(7,4),
  start_val numeric(8,2),
  base_val numeric(8,2),
  updated_at timestamptz default now(),
  primary key (store_id, ymd, section_id)
);
create index if not exists idx_plan_day on plan_day (store_id, ymd);

create table if not exists actual_day (
  store_id text not null references store(id),
  ymd date not null,
  section_id uuid not null references section_def(id),
  sales numeric(14,0),
  gross numeric(14,0),
  out_per_unit numeric(10,1),
  start_val numeric(8,2),
  base_val numeric(8,2),
  source text check (source in ('manual','csv','excel','ocr')),
  updated_at timestamptz default now(),
  primary key (store_id, ymd, section_id)
);
create index if not exists idx_actual_day on actual_day (store_id, ymd);

-- ---------- 台別・島図系 ----------
create table if not exists snapshot_period (
  id uuid primary key default gen_random_uuid(),
  store_id text not null references store(id),
  label text,
  start_date date, end_date date,
  is_current boolean default false,
  created_at timestamptz default now()
);

create table if not exists machine_snapshot (
  period_id uuid not null references snapshot_period(id) on delete cascade,
  dai_no integer not null,
  store_id text not null references store(id),
  section_id uuid references section_def(id),
  model_name text,
  out_val numeric(10,1), sa_val numeric(10,1), payout numeric(7,3),
  big_count numeric(6,1), sales numeric(12,0), gross numeric(12,0),
  primary key (period_id, dai_no)
);
create index if not exists idx_snap_section on machine_snapshot (store_id, section_id);
create index if not exists idx_snap_model on machine_snapshot (period_id, model_name);

create table if not exists layout_cell (
  store_id text not null references store(id),
  dai_no integer not null,
  floor text not null,
  grid_row smallint not null,
  grid_col smallint not null,
  primary key (store_id, dai_no),
  unique (store_id, floor, grid_row, grid_col)
);

create table if not exists fixture (
  id uuid primary key default gen_random_uuid(),
  store_id text not null references store(id),
  floor text not null,
  grid_row smallint, grid_col smallint,
  row_span smallint default 1, col_span smallint default 1,
  kind text, label text
);

-- ---------- シミュレーター系 ----------
create table if not exists model_spec (
  id uuid primary key default gen_random_uuid(),
  model_name text not null,
  setting smallint not null,
  payout_rate numeric(7,3),
  source text, source_url text, fetched_at timestamptz,
  unique (model_name, setting)
);

create table if not exists sim_session (
  id uuid primary key default gen_random_uuid(),
  store_id text not null references store(id),
  target_date date,
  plan_gross numeric(14,0),
  allocation jsonb,
  reason text,
  status text default 'draft',
  created_at timestamptz default now()
);

create table if not exists sim_comment (
  id uuid primary key default gen_random_uuid(),
  store_id text not null references store(id),
  model_name text,
  body text not null,
  source text default 'user',
  ymd date,
  created_at timestamptz default now()
);

-- ---------- その他 ----------
create table if not exists poster (
  id uuid primary key default gen_random_uuid(),
  store_id text not null references store(id),
  title text, intro_date date,
  models jsonb, image_path text, layout jsonb,
  created_at timestamptz default now()
);

create table if not exists import_log (
  id uuid primary key default gen_random_uuid(),
  store_id text not null references store(id),
  kind text, filename text, row_count integer,
  status text, message text,
  created_at timestamptz default now()
);

create table if not exists app_setting (
  store_id text not null references store(id),
  key text not null,
  value jsonb,
  primary key (store_id, key)
);

-- ---------- 初期データ ----------
insert into store (id, name) values ('toho-ikebukuro', 'TOHO池袋店')
  on conflict (id) do nothing;
insert into section_def (store_id, key, label, ptype, rate, sort_order) values
  ('toho-ikebukuro', 'S20', '20スロ', 'S', 21.75, 1),
  ('toho-ikebukuro', 'S5',  '5スロ',  'S', 5.56,  2),
  ('toho-ikebukuro', 'S2',  '2スロ',  'S', 2.22,  3)
  on conflict (store_id, key) do nothing;

-- ---------- RLS フェーズA（認証前・anon許可）----------
-- 注意: 公開リポ配信のため anon キーは公開情報。フェーズBでAuth必須へ差替える（設計書 §4.6）。
do $$
declare t text;
begin
  foreach t in array array[
    'store','section_def','budget_year','budget_month','machines_day','plan_day','actual_day',
    'snapshot_period','machine_snapshot','layout_cell','fixture','model_spec','sim_session',
    'sim_comment','poster','import_log','app_setting'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists anon_all on %I', t);
    execute format('create policy anon_all on %I for all using (true) with check (true)', t);
  end loop;
end $$;
