-- 新台トラッカー（周辺店の新台入替）をダッシュボードへ統合。
-- 取得は Edge Function「shindai-fetch」がDMMぱちタウン/P-WORLDから行い、ここに保存する。
-- PCのアプリ（新台入替トラッカー）は不要になる。
--
-- 実行手順（Supabase の SQL Editor で、このファイルを丸ごと貼って Run）:
--   事前に Edge Function「shindai-fetch」をデプロイしておくこと（自動実行がそれを呼ぶ）。

-- ---------- 追跡する店舗 ----------
create table if not exists shindai_shop (
  store_id text not null references store(id),
  key text not null,                 -- 'tokyo/467'（DMMの 都道府県/店舗ID）
  name text,
  url text,
  sort_order integer default 0,
  enabled boolean default true,
  primary key (store_id, key)
);

-- ---------- 日次スナップショット（その日の最終取得で上書き） ----------
create table if not exists shindai_snapshot (
  store_id text not null references store(id),
  shop_key text not null,
  day date not null,
  fetched_at timestamptz,
  source text,                       -- 'auto' / 'manual' / 'import'
  dmm_updated date,                  -- DMMの「機種情報 更新日」
  name text,
  total integer,
  unique_count integer,
  machines jsonb,                    -- {"機種ID|レート": {name,type,rate,count}}
  primary key (store_id, shop_key, day)
);

-- 認証必須（他テーブルと同じ。Edge Function は service_role で書き込む）
do $$
declare t text;
begin
  foreach t in array array['shindai_shop','shindai_snapshot'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists auth_all on %I', t);
    execute format('create policy auth_all on %I for all to authenticated using (true) with check (true)', t);
  end loop;
end $$;

-- ---------- 初期店舗（PCアプリで追跡していた12店舗） ----------
insert into shindai_shop (store_id, key, name, url, sort_order) values
  ('toho-ikebukuro', 'tokyo/467',   'ＴＯＨＯ池袋店',             'https://p-town.dmm.com/shops/tokyo/467',   1),
  ('toho-ikebukuro', 'tokyo/437',   '楽園池袋店',                 'https://p-town.dmm.com/shops/tokyo/437',   2),
  ('toho-ikebukuro', 'tokyo/13417', '楽園池袋店グリーンサイド',   'https://p-town.dmm.com/shops/tokyo/13417', 3),
  ('toho-ikebukuro', 'tokyo/449',   'マルハン池袋店',             'https://p-town.dmm.com/shops/tokyo/449',   4),
  ('toho-ikebukuro', 'tokyo/13328', 'マルハン池袋SLOTBASE',       'https://p-town.dmm.com/shops/tokyo/13328', 5),
  ('toho-ikebukuro', 'tokyo/465',   'YASUDA7（東池袋7号店）',     'https://p-town.dmm.com/shops/tokyo/465',   6),
  ('toho-ikebukuro', 'tokyo/441',   'YASUDA9（東池袋9号店）',     'https://p-town.dmm.com/shops/tokyo/441',   7),
  ('toho-ikebukuro', 'tokyo/13337', 'スマートプレゴ池袋',         'https://p-town.dmm.com/shops/tokyo/13337', 8),
  ('toho-ikebukuro', 'tokyo/440',   'プレゴ池袋南口店',           'https://p-town.dmm.com/shops/tokyo/440',   9),
  ('toho-ikebukuro', 'tokyo/456',   '甲子園池袋店',               'https://p-town.dmm.com/shops/tokyo/456',   10),
  ('toho-ikebukuro', 'tokyo/462',   'やすだ西池袋６号店',         'https://p-town.dmm.com/shops/tokyo/462',   11),
  ('toho-ikebukuro', 'tokyo/443',   'ＴＯＨＯ要町店',             'https://p-town.dmm.com/shops/tokyo/443',   12)
  on conflict (store_id, key) do nothing;

-- ---------- 自動実行（毎週月曜 10:10〜18:40 に30分おき） ----------
-- 1回目で全店を取得。2回目以降は「DMMの機種情報が今日付けになっていない店舗」だけ取り直す
-- （SLOTBASEのようにDMM側の更新が昼過ぎになる店舗の取り逃し対策）。
-- 時刻はUTC指定（日本時間-9時間）: 01:10〜09:40 UTC = 10:10〜18:40 JST。
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('shindai-auto') where exists (select 1 from cron.job where jobname = 'shindai-auto');
select cron.schedule(
  'shindai-auto',
  '10,40 1-9 * * 1',
  $$
  select net.http_post(
    url := 'https://ohnhtordgdjzdrhaeukz.supabase.co/functions/v1/shindai-fetch',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{"action":"auto"}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
