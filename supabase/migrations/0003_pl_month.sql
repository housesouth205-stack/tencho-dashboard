-- 会議資料（店舗別営業実績表）の月次データ。経費タブと取込タブが読み書きする。
--
-- このテーブルだけ移行ファイルが無かった。後から必要になってSupabaseの画面で
-- 直に作ったため、0001_init.sql にも 0002_auth_rls.sql のRLS対象一覧にも入っていない。
-- そのままだと、
--   ・新しい環境にスキーマを作り直すと経費タブだけ動かない
--   ・RLSが有効になっておらず、公開されている anon キーだけで読み書きできる
-- という2つの穴が残る（anonキーは GitHub Pages のソースに出ている）。
--
-- **本番には既にデータの入ったテーブルがある前提で書いてある。**
-- 何度流しても壊れないので、そのまま SQL Editor に貼って実行してよい。
-- 既にある列・データには触らない。足りないものだけ足す。

-- ---------- テーブル ----------
-- 金額はすべて円。資料は千円だが、アプリ内は円に揃えて持つ（取込時に1000倍する）。
create table if not exists pl_month (
  store_id text not null references store(id),
  ym date not null,                 -- 月度。月初の日付で持つ
  kind text not null,               -- 'actual'（実績）。予算を入れるときのために分けてある
  label text,                       -- 資料の表記そのまま（'R8.07'）。紙と突き合わせるため
  src text,                         -- 出典。ファイル名か'手入力'。後から出所を追えるように

  -- 損益
  sales numeric(14,0), cogs numeric(14,0), gross numeric(14,0),
  sga numeric(14,0), op numeric(14,0), ordinary numeric(14,0),
  -- 一般管理費の内訳（この6つの合計＝sga で検算する）
  jinken numeric(14,0), hanbai numeric(14,0), tatemono numeric(14,0),
  koukyou numeric(14,0), shokeihi numeric(14,0), genka numeric(14,0),
  -- 主な明細（上の区分の内数）
  kyuyo numeric(14,0), kigu numeric(14,0), suidou numeric(14,0),
  yachin numeric(14,0), hoshu numeric(14,0), shuzen numeric(14,0),

  updated_at timestamptz default now()
);

-- 手で作った本番のテーブルに足りない列があっても揃うようにする。
-- 列が1つ無いだけで取込がまるごと失敗するので、名前を並べて一括で足す。
do $$
declare c text;
begin
  foreach c in array array[
    'sales','cogs','gross','sga','op','ordinary',
    'jinken','hanbai','tatemono','koukyou','shokeihi','genka',
    'kyuyo','kigu','suidou','yachin','hoshu','shuzen'
  ] loop
    execute format('alter table pl_month add column if not exists %I numeric(14,0)', c);
  end loop;
  alter table pl_month add column if not exists label text;
  alter table pl_month add column if not exists src text;
  alter table pl_month add column if not exists updated_at timestamptz default now();
end $$;

-- アプリは (store_id, ym, kind) で upsert する。この一意制約が無いと
-- on conflict が効かず、取り込むたびに同じ月が増える。
-- 主キーではなく一意インデックスで作る（既にあるテーブルに主キーを足すと
-- 中身次第で失敗するが、インデックスなら if not exists で足せる）。
create unique index if not exists ux_pl_month_key on pl_month (store_id, ym, kind);
create index if not exists idx_pl_month_ym on pl_month (store_id, ym);

-- ---------- RLS（0002と同じフェーズB: ログイン済みのみ許可）----------
alter table pl_month enable row level security;
drop policy if exists anon_all on pl_month;   -- フェーズAのanon許可が残っていれば外す
drop policy if exists auth_all on pl_month;
create policy auth_all on pl_month for all to authenticated using (true) with check (true);

-- ---------- 確認 ----------
-- 実行後、これで rls有効 = true と、ポリシーが1つ出ることを確かめる。
--   select relname, relrowsecurity as rls有効 from pg_class where relname = 'pl_month';
--   select policyname, roles, cmd from pg_policies where tablename = 'pl_month';
-- 既存データが消えていないことも見ておく。
--   select count(*) as 月数, min(ym), max(ym) from pl_month;
