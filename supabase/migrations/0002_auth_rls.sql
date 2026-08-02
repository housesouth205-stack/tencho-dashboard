-- フェーズB: 認証必須へ切替え。
-- anon（未ログイン）を全面拒否し、authenticated（ログイン済み）のみ全操作を許可する。
-- 実行前に Authentication → Users で共有アカウント(config.jsのAUTH_EMAIL)を作成しておくこと。
-- 実行後、アプリはログインしないとデータを読み書きできなくなる。
do $$
declare t text;
begin
  foreach t in array array[
    'store','section_def','budget_year','budget_month','machines_day','plan_day','actual_day',
    'snapshot_period','machine_snapshot','layout_cell','fixture','model_spec','sim_session',
    'sim_comment','poster','import_log','app_setting'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists anon_all on %I', t);   -- フェーズAのanon許可を撤去
    execute format('drop policy if exists auth_all on %I', t);
    execute format('create policy auth_all on %I for all to authenticated using (true) with check (true)', t);
  end loop;
end $$;

-- 戻す場合（フェーズAへ復帰）は各テーブルで:
--   drop policy if exists auth_all on <table>;
--   create policy anon_all on <table> for all using (true) with check (true);
