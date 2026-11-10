-- 月次の損益・経費（経費タブの推移グラフ・取込の保存先）。
--
-- このテーブルは本番には既にある（経費タブを作ったときに SQL Editor で直接作った）が、
-- 定義がリポジトリに残っていなかった。新しい環境を作るときに困るので、アプリが読み書きして
-- いる列（src/import/plCsv.js の COLS）から書き起こしておく。
-- `if not exists` なので、本番で流しても既存のテーブルには何もしない。
-- 本番の列の型がこれと違っていても、アプリは数値として読むので動く。
--
-- 金額はすべて円（会議資料は千円なので、取込のとき1000倍している）。
-- kind: 'actual'（実績）／'budget'（予算。会議サマリーから入る）
create table if not exists pl_month (
  store_id text not null references store(id),
  ym date not null,                  -- 月初の日付（2026-08-01）
  kind text not null default 'actual',
  label text,                        -- 資料に書かれた月度（R8.08・令和8年8月）
  src text,                          -- 出典ファイル
  sales numeric(14,0),               -- 総売上高
  cogs numeric(14,0),                -- 売上原価
  gross numeric(14,0),               -- 売上総利益
  sga numeric(14,0),                 -- 一般管理費
  op numeric(14,0),                  -- 営業利益
  ordinary numeric(14,0),            -- 経常利益
  jinken numeric(14,0),              -- 人件費
  hanbai numeric(14,0),              -- 販売費
  tatemono numeric(14,0),            -- 建物管理費
  koukyou numeric(14,0),             -- 公共料金
  shokeihi numeric(14,0),            -- 一般諸経費
  genka numeric(14,0),               -- 減価償却費
  kyuyo numeric(14,0),               -- 給与計
  kigu numeric(14,0),                -- 消耗器具費（入替代）
  suidou numeric(14,0),              -- 水道光熱費
  yachin numeric(14,0),              -- 地代家賃
  hoshu numeric(14,0),               -- 保守料
  shuzen numeric(14,0),              -- 修繕費
  updated_at timestamptz default now(),
  primary key (store_id, ym, kind)
);

-- 認証必須（他テーブルと同じ）
alter table pl_month enable row level security;
drop policy if exists auth_all on pl_month;
create policy auth_all on pl_month for all to authenticated using (true) with check (true);
