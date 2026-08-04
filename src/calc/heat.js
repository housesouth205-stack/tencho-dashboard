// アウト/台売上/台粗利のヒートマップ 5段階（低い＝淡い黄 → 高い＝赤）。
export const HEAT5 = ["#fdf6c2", "#fce588", "#f9b234", "#ef6a1c", "#d62828"];
export const HEAT_MINUS = "#9fd8ef"; // マイナス（台粗利の赤字台）＝水色
export const HEAT_ZERO = "#fff";     // 0（稼働なし・撤去台）＝白

// 5段階レベル 0..4（淡黄→赤）。データ無し・0・マイナスは -1（専用色で表示）。
export function heatLevel(v, min, max) {
  if (v == null || isNaN(v) || v <= 0 || max <= min) return -1;
  const t = (v - min) / (max - min);
  return Math.min(4, Math.max(0, Math.floor(t * 5)));
}

// 列ごとの min/max で5段階に量子化して色を返す。
// マイナス（赤字台）は水色、0（稼働なし）は白、データ無しは無色。
export function heatColor(v, min, max) {
  const lv = heatLevel(v, min, max);
  if (lv >= 0) return HEAT5[lv];
  if (v == null || isNaN(v)) return "transparent";
  return v < 0 ? HEAT_MINUS : HEAT_ZERO;
}

// ヒートポイント（黄=1pt 〜 赤=5pt、データ無し=0）。
export function heatPoint(v, min, max) {
  const lv = heatLevel(v, min, max);
  return lv < 0 ? 0 : lv + 1;
}

// 配列から min/max。0以下（専用色で表示する赤字台・稼働なし台）は
// 色の基準から除く。含めると赤字台に引きずられて全体が実際より暖色に寄るため。
export function minMax(values) {
  const nums = values.filter((v) => v != null && !isNaN(v) && v > 0);
  return nums.length ? { min: Math.min(...nums), max: Math.max(...nums) } : { min: 0, max: 0 };
}

// 区分（レート）ごとの min/max。20スロと5スロではアウトも売上も桁が違うため、
// 全区分を一つの基準で色付けすると20スロが一律で低く（淡く）見えてしまう。
// 色は「その区分の中での高い/低い」で判定する。
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
export const groupRange = (map, key) => map.get(key) || { min: 0, max: 0 };

// ヒートセルの文字色（濃い赤背景では白寄り）。
export const heatText = (color) => (color === "#d62828" || color === "#ef6a1c" ? "#fff" : "#1a1a1d");
