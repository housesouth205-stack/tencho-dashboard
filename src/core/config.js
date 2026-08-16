// Supabase接続設定。空のままだとローカル保存(localStorage)で動作する。
// 本番: プロジェクト作成後に URL と anonキー を設定すると Supabase 接続に切替わる。
export const SUPABASE_URL = "https://ohnhtordgdjzdrhaeukz.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_RIuBFHINXFLzCkUB9yZcbg_Hm2yagYW";

// 単一店舗の固定ID（多店舗化まではこの値を全レコードに付与）。
export const STORE_ID = "toho-ikebukuro";
export const STORE_NAME = "TOHO池袋店";

export const FISCAL_START_MONTH = 4; // 会計年度の開始月

// 店舗固有: 台番号→区分（レート）の初期値。1F=20スロ、BF=2スロ＋5スロ。
// ヒートマップは「同じレートの中での高い/低い」で色を決めるため、スナップショットの
// 区分に依存せず台番号だけで判定できるようにしておく（データ未取込の台でも効く）。
//
// これは設定が空の店で使う種でしかない。実際の判定は core/daiSection.js の
// rateKeyOfDai()（設定タブで編集した値）を使うこと。入替のたびにここを直す運用はもうしない。
export const RATE_RANGES = [
  { key: "S20", from: 1, to: 144 },
  { key: "S2", from: 145, to: 192 },
  { key: "S5", from: 193, to: 304 },
];

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
// 設定ブロックを台のどちら側に置くか。通路に面している側に置く。
// 指定がない台は「同じ列の真下に台があれば上・なければ下」で自動判定する。
// 縦向きの島（145〜148・212〜219）は通路が左右にあるので横に置く。
export const SETTING_SIDES = [
  { from: 11, to: 17, side: "top" },
  { from: 130, to: 144, side: "top" },
  { from: 185, to: 192, side: "top" },
  { from: 145, to: 148, side: "right" },
  { from: 212, to: 219, side: "left" },
];
export const settingSideOfDai = (dai) =>
  SETTING_SIDES.find((r) => dai >= r.from && dai <= r.to)?.side || null;

// まとめて投入するとき（実績で選んで投入）に触らない台。
// ジャグラーの島は方針で設定を固定しているため、実績の良し悪しで動かさない。
// 1台ずつクリックして入れる操作は今までどおりできる。
export const BULK_EXCLUDE = [
  { from: 98, to: 105 },   // ジャグラー島
  { from: 114, to: 144 },  // ジャグラー島
];
export const isBulkExcluded = (dai) => BULK_EXCLUDE.some((r) => dai >= r.from && dai <= r.to);
export const bulkExcludeLabel = () => BULK_EXCLUDE.map((r) => `${r.from}〜${r.to}`).join("・");

// ISLAND_TWEAKS / SETTING_SIDES は台番の範囲で書いてあるので、入替で並びが
// 変わると黙って違う場所に効いてしまう。島図を取り込んだときにここで照合する。
// layout は取込直後の生の配置（tweakCell を通す前）。
export function checkIslandRules(layout) {
  const warn = [];
  const byDai = new Map(layout.map((c) => [c.dai_no, c]));
  const cellsOf = (r) => {
    const a = [];
    for (let d = r.from; d <= r.to; d++) { const c = byDai.get(d); if (c) a.push(c); }
    return a;
  };
  for (const r of [...ISLAND_TWEAKS, ...SETTING_SIDES, ...BULK_EXCLUDE]) {
    const label = `${r.from}〜${r.to}番`;
    const cs = cellsOf(r);
    if (!cs.length) { warn.push(`${label}：この台番が島図にありません`); continue; }
    const missing = r.to - r.from + 1 - cs.length;
    if (missing) warn.push(`${label}：${missing}台が島図に見つかりません`);
  }
  // 行をずらす指定は、同じ島の台を置き去りにすると島が分断される
  for (const r of ISLAND_TWEAKS) {
    if (!r.drow) continue;
    const cs = cellsOf(r);
    if (!cs.length) continue;
    // 行番号は階ごとに振られているので、必ず同じ階どうしで比べる
    const floors = new Set(cs.map((c) => c.floor));
    const rows = new Set(cs.map((c) => c.floor + ":" + c.grid_row));
    const left = layout.filter((c) => floors.has(c.floor) && rows.has(c.floor + ":" + c.grid_row)
      && (c.dai_no < r.from || c.dai_no > r.to)
      && cs.some((x) => x.floor === c.floor && Math.abs(x.grid_col - c.grid_col) <= 1));
    if (left.length) {
      const names = left.slice(0, 4).map((c) => c.dai_no).join("・");
      warn.push(`${r.from}〜${r.to}番：同じ島の ${names}${left.length > 4 ? " ほか" : ""} が範囲外です（島が分断されます）`);
    }
  }
  // 設定を左右に置く指定は、縦1列に並んでいることが前提
  for (const r of SETTING_SIDES) {
    if (r.side !== "left" && r.side !== "right") continue;
    const cs = cellsOf(r);
    if (cs.length && new Set(cs.map((c) => c.grid_col)).size > 1) {
      warn.push(`${r.from}〜${r.to}番：縦1列ではなくなっています（設定を横に置く指定です）`);
    }
  }
  return warn;
}

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
