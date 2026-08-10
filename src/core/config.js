// Supabase接続設定。空のままだとローカル保存(localStorage)で動作する。
// 本番: プロジェクト作成後に URL と anonキー を設定すると Supabase 接続に切替わる。
export const SUPABASE_URL = "https://ohnhtordgdjzdrhaeukz.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_RIuBFHINXFLzCkUB9yZcbg_Hm2yagYW";

// 単一店舗の固定ID（多店舗化まではこの値を全レコードに付与）。
export const STORE_ID = "toho-ikebukuro";
export const STORE_NAME = "TOHO池袋店";

export const FISCAL_START_MONTH = 4; // 会計年度の開始月

// 店舗固有: 台番号→区分（レート）。1F=20スロ、BF=2スロ＋5スロ。
// ヒートマップは「同じレートの中での高い/低い」で色を決めるため、スナップショットの
// 区分に依存せず台番号だけで判定できるようにしておく（データ未取込の台でも効く）。
export const RATE_RANGES = [
  { key: "S20", from: 1, to: 144 },
  { key: "S2", from: 145, to: 192 },
  { key: "S5", from: 193, to: 304 },
];
export const rateKeyOfDai = (dai) =>
  RATE_RANGES.find((r) => dai >= r.from && dai <= r.to)?.key || null;

// 島図の見た目の微調整。台番の範囲ごとにマス単位でずらす（drow=下が＋ / dcol=右が＋）。
// 島図Excelそのままだと空いた行が白帯になったり区分の境目が分かりにくいため、
// 画面で見やすい位置に寄せる。入替で台番が変わったらここを直す。
// 2スロ／5スロの間隔は列をずらしても変わらない（空いた列は通路1本に詰められるため）。
// 間隔は miniMap の rateGap で決まる。ここで右にずらすとBFだけ右へはみ出して
// 1Fと右端がそろわなくなるので、列の移動は入れない。
export const ISLAND_TWEAKS = [
  // 254〜287で1つの島（254-270と271-287の2列）。範囲を270からにすると島が
  // 分断されて271-287だけ上にずれるので、必ず島全体を指定する。
  { from: 254, to: 287, drow: -1 },
  { from: 288, to: 304, drow: -1 },
];
export const tweakCell = (c) => {
  let grid_row = c.grid_row, grid_col = c.grid_col;
  for (const t of ISLAND_TWEAKS) {
    if (c.dai_no >= t.from && c.dai_no <= t.to) { grid_row += t.drow || 0; grid_col += t.dcol || 0; }
  }
  return grid_row === c.grid_row && grid_col === c.grid_col ? c : { ...c, grid_row, grid_col };
};

export const hasSupabase = () => !!(SUPABASE_URL && SUPABASE_ANON_KEY);

// ----- 認証（フェーズB）-----
// 公開配信ではanonキーが露出するため、1つの共有アカウントでログイン必須にする。
// 画面ではパスワードのみ入力（メールはこの固定値を使用）。
// 有効化前に Supabase の Authentication→Users で AUTH_EMAIL のアカウントを作成し、
// 0002_auth_rls.sql を実行して RLS を認証必須へ切替えること。
// 2026-08-02: 共有アカウント作成＋0002_auth_rls.sql実行済み → 認証を有効化。
// RLSフェーズB適用済みのため、falseに戻すとデータを読めなくなる点に注意。
export const AUTH_ENABLED = true;
// メールは分割保持（公開ソースに素のアドレスを残さないための軽い難読化）
export const AUTH_EMAIL = ["housesouth205", "gmail.com"].join("@");
export const authRequired = () => AUTH_ENABLED && hasSupabase();
