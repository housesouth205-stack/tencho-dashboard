// アウト/台売上/台粗利のヒートマップ 5段階（低い＝淡い黄 → 高い＝赤）。
// 色の基準は「同じ区分（レート）の中での高い/低い」で、真ん中（3段階目）が平均。
// 色そのものはCSS（theme.css / theme-dq.css）の変数に置く。ここに直書きすると
// テーマを切り替えても島図と機種分析だけ白基調のまま取り残される。
// 変数が読めない環境（テスト等）では従来の値をそのまま使う。
const FALLBACK = {
  heat: ["#fdf6c2", "#fce588", "#f9b234", "#ef6a1c", "#d62828"],
  minus: "#9fd8ef", // マイナス（台粗利の赤字台）＝水色
  zero: "#fff",     // 0（稼働なし・撤去台）＝白
};

// 島図は300マス以上を一度に塗る。マスごとに getComputedStyle を呼ぶと重いので
// 一度読んだら保持し、テーマを切り替えたときだけ捨てる。
let cache = null;
export function refreshHeatPalette() { cache = null; }

function palette() {
  if (cache) return cache;
  let cs = null;
  try { cs = getComputedStyle(document.documentElement); } catch { /* DOM無しでも動かす */ }
  const read = (name, fb) => {
    const v = cs && cs.getPropertyValue(name).trim();
    return v || fb;
  };
  cache = {
    heat: FALLBACK.heat.map((fb, i) => read(`--heat-${i + 1}`, fb)),
    minus: read("--heat-minus", FALLBACK.minus),
    zero: read("--heat-zero", FALLBACK.zero),
  };
  return cache;
}

export const heat5 = () => palette().heat;
export const heatMinus = () => palette().minus;
export const heatZero = () => palette().zero;

// 5段階レベル 0..4（淡黄→赤）。データ無し・0・マイナスは -1（専用色で表示）。
// 平均を中央に置くため、min〜平均 と 平均〜max をそれぞれ2.5段階ぶんに割り付ける
// （単純な min〜max の線形だと、平均が分布の偏りしだいで端に寄ってしまう）。
export function heatLevel(v, range) {
  const { min = 0, max = 0, avg } = range || {};
  if (v == null || isNaN(v) || v <= 0 || !(max > min)) return -1;
  const m = avg == null ? (min + max) / 2 : avg;
  const t = v <= m
    ? (m > min ? 2.5 * (v - min) / (m - min) : 2.5)
    : (max > m ? 2.5 + 2.5 * (v - m) / (max - m) : 2.5);
  return Math.min(4, Math.max(0, Math.floor(t)));
}

// 区分ごとの min/max/avg で5段階に量子化して色を返す。
// マイナス（赤字台）は水色、0（稼働なし）は白、データ無しは無色。
export function heatColor(v, range) {
  const lv = heatLevel(v, range);
  const p = palette();
  if (lv >= 0) return p.heat[lv];
  if (v == null || isNaN(v)) return "transparent";
  return v < 0 ? p.minus : p.zero;
}

// ヒートポイント（黄=1pt 〜 赤=5pt、データ無し=0）。平均の台は3pt。
export function heatPoint(v, range) {
  const lv = heatLevel(v, range);
  return lv < 0 ? 0 : lv + 1;
}

// 配列から min/max/avg。0以下（専用色で表示する赤字台・稼働なし台）は
// 色の基準から除く。含めると赤字台に引きずられて全体が実際より暖色に寄るため。
export function minMax(values) {
  const nums = values.filter((v) => v != null && !isNaN(v) && v > 0);
  if (!nums.length) return { min: 0, max: 0, avg: 0 };
  return {
    min: Math.min(...nums),
    max: Math.max(...nums),
    avg: nums.reduce((a, b) => a + b, 0) / nums.length,
  };
}

// 区分（レート）ごとの min/max/avg。20スロと低貸ではアウトも売上も桁が違うため、
// 全区分を一つの基準で色付けすると20スロが一律で低く（淡く）見えてしまう。
export function minMaxByGroup(items, groupOf, valueOf) {
  const buckets = new Map();
  for (const it of items) {
    const k = groupOf(it);
    if (k == null) continue;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(valueOf(it));
  }
  const out = new Map();
  for (const [k, vals] of buckets) out.set(k, minMax(vals));
  return out;
}

// グループ未該当（区分不明の台）は色の基準なし＝専用色にフォールバックさせる。
export const groupRange = (map, key) => map.get(key) || { min: 0, max: 0, avg: 0 };

// ヒートセルの文字色。もとは特定の2色と文字列比較していたが、それだとテーマを
// 変えた瞬間に暗い背景へ黒文字を乗せてしまう。背景の明るさから決める。
export function heatText(color) {
  const rgb = hexToRgb(color);
  if (!rgb) return "#1a1a1d"; // transparent など読めない指定は既定の黒寄り
  // 相対輝度（ざっくり係数。境目の判定に使うだけなので厳密なsRGB変換は要らない）
  const lum = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
  return lum < 0.55 ? "#fff" : "#1a1a1d";
}

function hexToRgb(c) {
  if (typeof c !== "string") return null;
  const m = c.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{6}$/.test(m)) return null;
  const h = m.length === 3 ? m.split("").map((x) => x + x).join("") : m;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
