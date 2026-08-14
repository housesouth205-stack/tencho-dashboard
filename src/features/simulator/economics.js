// 出玉率(機械割)は小数第1位で統一する。表示・入力・保存・計算すべてこの値を使い、
// 「画面の数字」と「計算に使う数字」を必ず一致させる。
export const round1 = (v) => (v == null || v === "" || isNaN(v) ? null : Math.round(Number(v) * 10) / 10);
// 表示用（112 → "112.0"）。常に小数第1位まで見せる。
export const fmt1 = (v) => (v == null || isNaN(v) ? "—" : Number(v).toFixed(1));

// 出玉率→売上/粗利の計算（社内資料の計数管理方式・貸単価別）。
// 売上 = アウト × コイン単価
// 損益分岐出玉率 = 100 + (交換枚数K − 貸出枚数L) × コイン単価
// 出玉率1%あたりコイン粗利 = (貸単価 ÷ 100) × (貸出枚数L ÷ 交換枚数K)
//   ※(貸単価÷100)=20円等価での0.2に相当。低貸しは額面に比例(5円→0.05/2円→0.02)。
//     これを一律0.2にすると5スロ/2スロの利益が4〜10倍過大になるため貸単価別にする。
// 台粗利 = (損益分岐 − 出玉率) × 1%あたりコイン粗利 × アウト
export function computeMachine({ out, coin, payout, L, K, tanka = 20 }) {
  const sales = out * coin;
  const be = 100 + (K - L) * coin;
  const coinGrossPer1 = (tanka / 100) * (K ? L / K : 0); // 1%あたりコイン粗利
  // 出玉率は画面表示と同じ小数第1位に丸めてから計算する（表示と結果を一致させる）
  const gross = (be - round1(payout)) * coinGrossPer1 * out;
  return { sales, gross, be, grossRate: sales ? gross / sales : 0 };
}

// 区分の額面貸単価(円)。S20→20 / S5→5 / S2→2。粗利の1%単価に使用。
export function sectionTanka(section) {
  return parseInt(String(section.key).replace(/\D/g, ""), 10) || 20;
}

// タイプ別の出玉率(機械割)既定カーブ 設定1→6。編集可。
// BT機（型式名がLBで始まるボーナストリガー機）のカーブは、機種DBに入っている
// LB機19機種の実測値から出した。設定1・6は各機種の中央値、設定2〜5は
// 「設定1を0・設定6を1とした相対位置」の中央値(0.170/0.228/0.488/0.600)を当てたもの。
// 他タイプの既定カーブと違い、当てずっぽうではなく実データ由来。
export const TYPES = {
  "Aタイプ": [97.0, 98.0, 99.5, 101.0, 103.0, 106.0],
  "AT機": [97.5, 98.5, 99.5, 102.0, 106.0, 112.0],
  "BT機": [98.0, 99.7, 100.3, 102.9, 104.1, 108.1],
  "甘・ライト": [98.5, 99.5, 100.5, 101.5, 103.0, 105.5],
  "その他": [98.0, 99.0, 100.0, 101.5, 104.0, 108.0],
};
export const TYPE_KEYS = Object.keys(TYPES);

// 貸出枚数L(100円あたり) の既定値。当店の実営業を反映:
//   20スロ=46枚貸し(1000円46枚)→ 4.6。他は等価(100÷貸単価円)。
// ※各区分ごとに設定画面で上書き保存可(settei_exchange)。
const STORE_KASHI = { 20: 4.6 };
export function sectionL(section) {
  const yen = parseInt(String(section.key).replace(/\D/g, ""), 10) || 20;
  return STORE_KASHI[yen] ?? 100 / yen;
}

// DMMのレンジ[設定1,設定6]を、タイプ標準カーブの「形」を保ったまま[lo,hi]へ写像し
// 設定2〜5を推定する。DMMは大半の機種で下限/上限しか公表しないため、この補間で全設定を埋める。
export function interpolateCurve(lo, hi, type) {
  const base = TYPES[type] || TYPES["その他"];
  const span = base[5] - base[0];
  return base.map((b) => {
    const norm = span ? (b - base[0]) / span : 0; // 標準カーブ上の相対位置(0..1)
    return Math.round((lo + norm * (hi - lo)) * 10) / 10;
  });
}

// Web取得結果から設定別出玉率を決める。per6(設定別実測)優先、無ければrange+補間。
//
// per6の欠番(null)は「その機種にその設定が無い」という情報そのものなので、埋めずに残す。
// 設定3が無い機種・設定1256しかない機種があり、シミュレーターはこれを見て
// 存在しない設定を割り当てないようにしている。
// レンジ(設定1と6だけ)からの補間では欠番は分からないため、そちらは6つとも埋まる。
export function payoutFromDmm({ range, per6 }, type) {
  if (per6 && per6.filter((v) => v != null).length >= 3) {
    return per6.map((v) => (v == null ? null : Math.round(v * 10) / 10));
  }
  if (range && range.length === 2) return interpolateCurve(range[0], range[1], type);
  return null;
}

// 欠番を前後の値から埋める。**計算用にだけ**使う。
// 存在しない設定でも粗利の式が数値を要求する場面があるため穴を塞ぐが、
// 「使える設定かどうか」の判定には使わない（判定は元の配列の null を見る）。
export function fillHoles(a6) {
  const a = [...a6];
  for (let i = 0; i < 6; i++) {
    if (a[i] != null) continue;
    let lo = i - 1, hi = i + 1;
    while (lo >= 0 && a[lo] == null) lo--;
    while (hi < 6 && a[hi] == null) hi++;
    const L = lo >= 0 ? a[lo] : null, H = hi < 6 ? a[hi] : null;
    a[i] = L != null && H != null ? (L + H) / 2 : (L != null ? L : H);
  }
  return a.map((v) => (v == null ? null : Math.round(v * 10) / 10));
}

// その機種で実際に使える設定の一覧。
// payout の空欄＝その機種に無い設定。1つも登録が無い機種は判断材料が無いので1〜6すべて。
// min（設定1でパネルが消灯する機種の最低設定）より下も除く。
export function usableSettings(payout, min = 1) {
  const ALL = [1, 2, 3, 4, 5, 6];
  const known = payout && payout.some((v) => v != null);
  const exist = known ? ALL.filter((s) => payout[s - 1] != null) : ALL;
  const above = exist.filter((s) => s >= (min || 1));
  // 最低設定より上が1つも無いなら、最低設定の縛りより「実在すること」を優先する
  return above.length ? above : exist;
}

// 入れたい設定を、その機種にある設定に寄せる。
// 無ければ上の設定へ（設定4が無ければ5）。上に無ければ一番上へ落とす。
export function snapSetting(want, usable) {
  const w = Number(want) || 1;
  if (!usable || !usable.length || usable.includes(w)) return w;
  const up = usable.filter((s) => s > w);
  return up.length ? Math.min(...up) : Math.max(...usable);
}
